// lib/scalelite-stack.ts

import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    IVpc,
    SecurityGroup,
    Peer,
    Port,
    SubnetType
} from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import {
    Cluster,
    FargateService,
    FargateTaskDefinition,
    ContainerImage,
    Volume,
    EfsVolumeConfiguration,
    Secret as EcsSecret
} from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
    HostedZone,
    ARecord,
    RecordTarget
} from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface ScaleliteStackProps extends StackProps {
    readonly vpc: IVpc;
    readonly dbCluster: DatabaseCluster;
    readonly redisEndpoint: string;
    readonly redisSecurityGroup: SecurityGroup;
    readonly sharedSecret: Secret;
    readonly domainName: string;
    readonly certificateArn: string;
}

export class ScaleliteStack extends Stack {
    public readonly apiEndpoint: string;
    public readonly scaleliteAlb5xxErrorsAlarm: cloudwatch.Alarm;
    public readonly scaleliteServiceHighCPUAlarm: cloudwatch.Alarm;
    public readonly scaleliteServiceHighMemoryAlarm: cloudwatch.Alarm;
    public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
    public readonly service: FargateService;

    constructor(scope: Construct, id: string, props: ScaleliteStackProps) {
        super(scope, id, props);

        // ── ONE Security Group for HTTP/S + NFS ──────────────────────────────
        const sg = new SecurityGroup(this, 'ScaleliteSG', {
            vpc: props.vpc,
            description: 'Allow HTTP/S and NFS to Scalelite',
            allowAllOutbound: true,
        });
        // HTTP/S Ingress
        sg.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'HTTP');
        sg.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS');
        // NFS (EFS) from the tasks/hosts
        sg.addIngressRule(sg, Port.tcp(2049), 'NFS from Fargate host');

        // ── Egress to DB & Redis ──────────────────────────────────────────────
        sg.addEgressRule(
            props.dbCluster.connections.securityGroups[0],
            Port.tcp(3306),
            'Outbound to Aurora MySQL'
        );
        sg.addEgressRule(
            props.redisSecurityGroup,
            Port.tcp(6379),
            'Outbound to Redis'
        );

        // ── EFS for Recordings ─────────────────────────────────────────────────
        const fileSystem = new efs.FileSystem(this, 'ScaleliteEFS', {
            vpc: props.vpc,
            encrypted: true,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            removalPolicy: RemovalPolicy.RETAIN,
            vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup: sg, // use the same SG
        });

        const accessPoint = fileSystem.addAccessPoint('ScaleliteAccessPoint', {
            path: '/scalelite_recordings',
            createAcl: {
                ownerUid: '1000',
                ownerGid: '1000',
                permissions: '0755',
            },
            posixUser: {
                uid: '1000',
                gid: '1000',
            },
        });

        // ── ECS Cluster & Task Definition ──────────────────────────────────────
        const cluster = new Cluster(this, 'ScaleliteCluster', { vpc: props.vpc });

        const scaleliteVolume: Volume = {
            name: 'scalelite-recordings',
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
                transitEncryption: 'ENABLED',
                authorizationConfig: {
                    accessPointId: accessPoint.accessPointId,
                    iam: 'DISABLED',
                },
            } as EfsVolumeConfiguration,
        };

        const taskDef = new FargateTaskDefinition(this, 'ScaleliteTask', {
            cpu: 512,
            memoryLimitMiB: 1024,
            volumes: [scaleliteVolume],
        });

        fileSystem.grant(
            taskDef.taskRole,
            'elasticfilesystem:ClientMount',
            'elasticfilesystem:ClientWrite'
        );


        const container = taskDef.addContainer('api', {
            image: ContainerImage.fromRegistry('blindsidenetwks/scalelite:v1.6.5'),
            environment: {
                REDIS_URL: `${props.redisEndpoint}:6379`,
                DB_HOST:   props.dbCluster.clusterEndpoint.hostname,
                DB_NAME:   'scalelite_production',
                DB_USER:   'scalelite_admin',
            },
            secrets: {
                DB_PASS:       EcsSecret.fromSecretsManager(props.dbCluster.secret!, 'password'),
                SHARED_SECRET: EcsSecret.fromSecretsManager(props.sharedSecret),
            },
        });
        container.addPortMappings({ containerPort: 80 });
        container.addMountPoints({
            containerPath: '/var/lib/scalelite/data',
            sourceVolume: scaleliteVolume.name,
            readOnly: false,
        });

        // ── Fargate Service & ALB ──────────────────────────────────────────────
        this.service = new FargateService(this, 'ScaleliteService', {
            cluster,
            taskDefinition: taskDef,
            desiredCount: 2,
            securityGroups: [sg],
            assignPublicIp: false,
            vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        });

        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ScaleliteALB', {
            vpc: props.vpc,
            internetFacing: true,
            securityGroup: sg,
        });
        const cert = Certificate.fromCertificateArn(this, 'ACMCert', props.certificateArn);
        const listener = this.loadBalancer.addListener('HttpsListener', {
            port: 443,
            certificates: [cert],
            protocol: elbv2.ApplicationProtocol.HTTPS,
            open: true,
        });
        listener.addTargets('ScaleliteTG', {
            port: 80,
            targets: [ this.service.loadBalancerTarget({ containerName: 'api', containerPort: 80 }) ],
        });

        // ── Route53 A Record ───────────────────────────────────────────────────
        const zone = HostedZone.fromLookup(this, 'Zone', { domainName: props.domainName });
        new ARecord(this, 'AliasRecord', {
            zone,
            recordName: 'bbb',
            target: RecordTarget.fromAlias(new LoadBalancerTarget(this.loadBalancer)),
        });
        this.apiEndpoint = `https://bbb.${props.domainName}`;

        // ── WAFv2 ──────────────────────────────────────────────────────────────
        const webAcl = new wafv2.CfnWebACL(this, 'ScaleliteWebACL', {
            name: 'ScaleliteWebACL',
            scope: 'REGIONAL',
            defaultAction: { allow: {} },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: 'ScaleliteWebACLMetric',
                sampledRequestsEnabled: true,
            },
            rules: [
            ],
        });
        new wafv2.CfnWebACLAssociation(this, 'ScaleliteWebACLAssociation', {
            resourceArn: this.loadBalancer.loadBalancerArn,
            webAclArn: webAcl.attrArn,
        });

        // ── CloudWatch Alarms ─────────────────────────────────────────────────
        this.scaleliteAlb5xxErrorsAlarm = new cloudwatch.Alarm(this, 'ScaleliteALB5xxErrorsAlarm', {
            alarmName: 'ScaleliteALB5xxErrorsAlarm',
            alarmDescription: 'Triggers if the Scalelite ALB sees ≥ 5 HTTP 5xx responses in 5 minutes.',
            metric: this.loadBalancer.metricHttpCodeElb(
                elbv2.HttpCodeElb.ELB_5XX_COUNT,
                { statistic: cloudwatch.Statistic.SUM, period: Duration.minutes(5) }
            ),
            threshold: 5,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        this.scaleliteServiceHighCPUAlarm = new cloudwatch.Alarm(this, 'ScaleliteServiceHighCPUAlarm', {
            alarmName: 'ScaleliteServiceHighCPUAlarm',
            alarmDescription: 'Triggers if the Scalelite Fargate CPU > 85% for 15 minutes.',
            metric: this.service.metricCpuUtilization({
                period: Duration.minutes(5),
                statistic: cloudwatch.Statistic.AVERAGE,
            }),
            threshold: 85,
            evaluationPeriods: 3,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        this.scaleliteServiceHighMemoryAlarm = new cloudwatch.Alarm(this, 'ScaleliteServiceHighMemoryAlarm', {
            alarmName: 'ScaleliteServiceHighMemoryAlarm',
            alarmDescription: 'Triggers if the Scalelite Fargate Memory > 85% for 15 minutes.',
            metric: this.service.metricMemoryUtilization({
                period: Duration.minutes(5),
                statistic: cloudwatch.Statistic.AVERAGE,
            }),
            threshold: 85,
            evaluationPeriods: 3,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
    }
}
