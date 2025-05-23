// lib/database-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    IVpc, SubnetType, SecurityGroup, Peer, Port
} from 'aws-cdk-lib/aws-ec2';
import {
    DatabaseCluster,
    DatabaseClusterEngine,
    AuroraMysqlEngineVersion,
    Credentials
} from 'aws-cdk-lib/aws-rds';
import { CfnSubnetGroup, CfnCacheCluster } from 'aws-cdk-lib/aws-elasticache';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

export interface DatabaseStackProps extends StackProps {
    readonly vpc: IVpc;
}

export class DatabaseStack extends Stack {
    public readonly dbCluster: DatabaseCluster;
    public readonly redisEndpoint: string;
    public readonly sharedSecret: Secret;

    constructor(scope: Construct, id: string, props: DatabaseStackProps) {
        super(scope, id, props);

        this.sharedSecret = new Secret(this, 'SharedSecret', {
            secretName: 'scalelite-shared-secret',
            generateSecretString: {
                secretStringTemplate: JSON.stringify({}),
                generateStringKey: 'secret'
            }
        });

        this.dbCluster = new DatabaseCluster(this, 'ScaleliteDB', {
            engine: DatabaseClusterEngine.auroraMysql({
                version: AuroraMysqlEngineVersion.VER_2_10_0
            }),
            credentials: Credentials.fromGeneratedSecret('scalelite_admin'),
            instances: 2,
            defaultDatabaseName: 'scalelite_production',
            instanceProps: {
                vpc: props.vpc,
                vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS }
            }
        });

        const subnetGroup = new CfnSubnetGroup(this, 'RedisSubnetGroup', {
            description: 'Subnet group for Scalelite Redis',
            subnetIds: props.vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
            cacheSubnetGroupName: 'scalelite-redis-subnets'
        });

        const redisSg = new SecurityGroup(this, 'RedisSG', {
            vpc: props.vpc,
            description: 'Allow Redis access within VPC',
            allowAllOutbound: true
        });
        redisSg.addIngressRule(
            Peer.ipv4(props.vpc.vpcCidrBlock),
            Port.tcp(6379),
            'Allow Redis traffic inside VPC'
        );

        const redis = new CfnCacheCluster(this, 'ScaleliteRedis', {
            engine: 'redis',
            cacheNodeType: 'cache.t3.micro',
            numCacheNodes: 1,
            cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
            vpcSecurityGroupIds: [redisSg.securityGroupId]
        });

        this.redisEndpoint = redis.attrRedisEndpointAddress;
    }
}
