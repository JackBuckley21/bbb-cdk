import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    IVpc, SecurityGroup, Peer, Port, SubnetType
} from 'aws-cdk-lib/aws-ec2';
import {
    Cluster, FargateService, FargateTaskDefinition, ContainerImage
} from 'aws-cdk-lib/aws-ecs';
import {
    ApplicationLoadBalancer, ApplicationProtocol
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

export interface ScaleliteStackProps extends StackProps {
    readonly vpc: IVpc;
    readonly dbCluster: DatabaseCluster;
    readonly redisEndpoint: string;
    readonly sharedSecret: Secret;
    readonly domainName: string;
    readonly certificateArn: string;
}

export class ScaleliteStack extends Stack {
    public readonly apiEndpoint: string;

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


        const cluster = new Cluster(this, 'ScaleliteCluster', { vpc: props.vpc });


        const taskDef = new FargateTaskDefinition(this, 'ScaleliteTask', {
            cpu: 512,
            memoryLimitMiB: 1024
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


        const service = new FargateService(this, 'ScaleliteService', {
            cluster,
            taskDefinition: taskDef,
            desiredCount: 2,
            securityGroups: [scaleliteSg],
            assignPublicIp: false,
            vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS }
        });


        const lb = new ApplicationLoadBalancer(this, 'ScaleliteALB', {
            vpc: props.vpc,
            internetFacing: true,
            securityGroup: scaleliteSg
        });
        const cert = Certificate.fromCertificateArn(this, 'ACMCert', props.certificateArn);
        const listener = lb.addListener('HttpsListener', {
            port: 443,
            certificates: [cert],
            protocol: ApplicationProtocol.HTTPS,
            open: true
        });
        listener.addTargets('ScaleliteTG', {
            port: 80,
            targets: [ service.loadBalancerTarget({ containerName: 'api', containerPort: 80 }) ]
        });


        const zone = HostedZone.fromLookup(this, 'Zone', {
            domainName: props.domainName
        });
        const subdomain = 'bbb';
        new ARecord(this, 'AliasRecord', {
            zone,
            recordName: subdomain,
            target: RecordTarget.fromAlias(new LoadBalancerTarget(lb))
        });

        this.apiEndpoint = `https://${subdomain}.${props.domainName}`;
    }
}
