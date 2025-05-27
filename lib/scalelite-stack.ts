import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    IVpc, SecurityGroup, Peer, Port, SubnetType
} from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
// aws-sns and aws-cloudwatch-actions will not be used directly in this file for adding actions to these alarms
// as the actions will be added in bin/bbb-cdk.ts to break circular dependency.
import {
    Cluster, FargateService, FargateTaskDefinition, ContainerImage, Volume, EfsVolumeConfiguration
} from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'; // Changed to namespace import
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
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
    // Reference to the ALB and ECS Service if needed for metric creation outside, though direct metric methods are preferred.
    public readonly loadBalancer: elbv2.ApplicationLoadBalancer; // Adjusted type due to import change
    public readonly service: FargateService;


    constructor(scope: Construct, id: string, props: ScaleliteStackProps) {
        super(scope, id, props);


        const scaleliteSg = new SecurityGroup(this, 'ScaleliteSG', {
            vpc: props.vpc,
            description: 'Allow HTTP/S to Scalelite',
            allowAllOutbound: true
        });
        scaleliteSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'HTTP');
        scaleliteSg.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS');


        props.dbCluster.connections.allowDefaultPortFrom(scaleliteSg);
        props.redisSecurityGroup.addIngressRule(
            scaleliteSg,
            Port.tcp(6379),
            'Allow Redis access from Scalelite service'
        );

        // EFS for Scalelite Recordings
        const efsSg = new SecurityGroup(this, 'EfsSG', {
            vpc: props.vpc,
            description: 'Allow EFS access from Scalelite service',
            allowAllOutbound: true
        });
        efsSg.addIngressRule(
            scaleliteSg,
            Port.tcp(2049), // NFS port
            'Allow NFS traffic from Scalelite service'
        );

        const fileSystem = new efs.FileSystem(this, 'ScaleliteEFS', {
            vpc: props.vpc,
            encrypted: true,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            removalPolicy: RemovalPolicy.RETAIN, // Change to DESTROY for non-prod if needed
            vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup: efsSg
        });

        const accessPoint = fileSystem.addAccessPoint('ScaleliteAccessPoint', {
            path: '/scalelite_recordings',
            createAcl: {
                ownerGid: '1000',
                ownerUid: '1000',
                permissions: '0755'
            },
            posixUser: {
                gid: '1000',
                uid: '1000'
            }
        });


        const cluster = new Cluster(this, 'ScaleliteCluster', { vpc: props.vpc });


        const scaleliteVolume: Volume = {
            name: 'scalelite-recordings',
            efsVolumeConfiguration: {
              fileSystemId: fileSystem.fileSystemId,
              transitEncryption: 'ENABLED',
              authorizationConfig: {
                accessPointId: accessPoint.accessPointId,
                iam: 'DISABLED'
              }
            }
        };

        const taskDef = new FargateTaskDefinition(this, 'ScaleliteTask', {
            cpu: 512,
            memoryLimitMiB: 1024,
            volumes: [scaleliteVolume]
        });
        const container = taskDef.addContainer('api', {
            image: ContainerImage.fromRegistry('blindsidenetworks/scalelite'),
            environment: {
                REDIS_URL: `${props.redisEndpoint}:6379`,
                DB_HOST:   props.dbCluster.clusterEndpoint.hostname,
                DB_NAME:   'scalelite_production',
                DB_USER:   'scalelite_admin',
                DB_PASS:   props.dbCluster.secret?.secretValueFromJson('password')?.toString() || '',
                SHARED_SECRET: props.sharedSecret.secretValue.toString()
            }
        });
        container.addPortMappings({ containerPort: 80 });
        container.addMountPoints({
            containerPath: '/var/lib/scalelite/data',
            sourceVolume: scaleliteVolume.name,
            readOnly: false
        });


        this.service = new FargateService(this, 'ScaleliteService', {
            cluster,
            taskDefinition: taskDef,
            desiredCount: 2,
            securityGroups: [scaleliteSg],
            assignPublicIp: false,
            vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS }
        });


        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ScaleliteALB', { // Adjusted type
            vpc: props.vpc,
            internetFacing: true,
            securityGroup: scaleliteSg
        });
        const cert = Certificate.fromCertificateArn(this, 'ACMCert', props.certificateArn);
        const listener = this.loadBalancer.addListener('HttpsListener', { // Adjusted type
            port: 443,
            certificates: [cert],
            protocol: elbv2.ApplicationProtocol.HTTPS, // Adjusted type
            open: true
        });
        listener.addTargets('ScaleliteTG', {
            port: 80,
            targets: [ this.service.loadBalancerTarget({ containerName: 'api', containerPort: 80 }) ]
        });


        const zone = HostedZone.fromLookup(this, 'Zone', {
            domainName: props.domainName
        });
        const subdomain = 'bbb';
        new ARecord(this, 'AliasRecord', {
            zone,
            recordName: subdomain,
            target: RecordTarget.fromAlias(new LoadBalancerTarget(this.loadBalancer))
        });

        // WAFv2 for ALB
        const webAcl = new wafv2.CfnWebACL(this, 'ScaleliteWebACL', {
            name: 'ScaleliteWebACL',
            scope: 'REGIONAL',
            defaultAction: { allow: {} },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: 'ScaleliteWebACLMetric',
                sampledRequestsEnabled: true
            },
            rules: [
                {
                    name: 'AWS-AWSManagedRulesCommonRuleSet',
                    priority: 1,
                    statement: {
                        managedRuleGroupStatement: {
                            vendorName: 'AWS',
                            name: 'AWSManagedRulesCommonRuleSet'
                        }
                    },
                    overrideAction: { none: {} },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'AWSManagedRulesCommonRuleSetMetric',
                        sampledRequestsEnabled: true
                    }
                },
                {
                    name: 'AWS-AWSManagedRulesAmazonIpReputationList',
                    priority: 2,
                    statement: {
                        managedRuleGroupStatement: {
                            vendorName: 'AWS',
                            name: 'AWSManagedRulesAmazonIpReputationList'
                        }
                    },
                    overrideAction: { none: {} },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'AWSManagedRulesAmazonIpReputationListMetric',
                        sampledRequestsEnabled: true
                    }
                }
            ]
        });

        new wafv2.CfnWebACLAssociation(this, 'ScaleliteWebACLAssociation', {
            resourceArn: this.loadBalancer.loadBalancerArn,
            webAclArn: webAcl.attrArn
        });


        this.apiEndpoint = `https://${subdomain}.${props.domainName}`;

        // --- Critical Alarms Setup (actions to be added in bin/bbb-cdk.ts) ---

        // 1. Scalelite ALB 5xx Errors Alarm
        this.scaleliteAlb5xxErrorsAlarm = new cloudwatch.Alarm(this, 'ScaleliteALB5xxErrorsAlarm', {
            alarmName: 'ScaleliteALB5xxErrorsAlarm',
            alarmDescription: 'Triggers if the Scalelite ALB experiences >= 5 HTTP 5xx errors in 5 minutes.', // Reverted description
            metric: this.loadBalancer.metricHttpCode(elbv2.HttpCode.ELB_5XX_COUNT, { // Changed to metricHttpCode and elbv2.HttpCode
                period: Duration.minutes(5),
                statistic: cloudwatch.Statistic.SUM, // Preserved statistic
            }),
            threshold: 5, // Preserved
            evaluationPeriods: 1, // Preserved
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, // Preserved
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // Preserved
        });

        // 2. Scalelite ECS Fargate Service CPU Utilization Alarm
        this.scaleliteServiceHighCPUAlarm = new cloudwatch.Alarm(this, 'ScaleliteServiceHighCPUAlarm', {
            alarmName: 'ScaleliteServiceHighCPUAlarm',
            alarmDescription: 'Triggers if the Scalelite Fargate service average CPU utilization exceeds 85% for 15 minutes.', // Note: This is a different alarm, ensure this is not unintentionally matched.
            metric: this.service.metricCpuUtilization({
                period: Duration.minutes(5),
                statistic: cloudwatch.Statistic.AVERAGE,
            }),
            threshold: 85,
            evaluationPeriods: 3, // 3 * 5 minutes = 15 minutes
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // 3. Scalelite ECS Fargate Service Memory Utilization Alarm
        this.scaleliteServiceHighMemoryAlarm = new cloudwatch.Alarm(this, 'ScaleliteServiceHighMemoryAlarm', {
            alarmName: 'ScaleliteServiceHighMemoryAlarm',
            alarmDescription: 'Triggers if the Scalelite Fargate service average memory utilization exceeds 85% for 15 minutes.',
            metric: this.service.metricMemoryUtilization({
                period: Duration.minutes(5),
                statistic: cloudwatch.Statistic.AVERAGE,
            }),
            threshold: 85,
            evaluationPeriods: 3, // 3 * 5 minutes = 15 minutes
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // Recommendation for Application-Level Metrics:
        // Consider implementing application-level metrics for Scalelite.
        // This could include API error rates (non-5xx), specific API endpoint latencies,
        // or queue depths if applicable.
        // These custom metrics can be published to CloudWatch and alarmed upon for deeper operational insights.
    }
}
