import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    IVpc,
    SubnetType,
    SecurityGroup
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
    readonly redisInstanceType?: string;
}

export class DatabaseStack extends Stack {
    public readonly dbCluster: DatabaseCluster;
    public readonly redisEndpoint: string;
    public readonly redisSg: SecurityGroup;
    public readonly sharedSecret: Secret;

    constructor(scope: Construct, id: string, props: DatabaseStackProps) {
        super(scope, id, props);

        // 1) Shared secret for Scalelite
        this.sharedSecret = new Secret(this, 'SharedSecret', {
            secretName: 'scalelite-shared-secret',
            generateSecretString: {
                secretStringTemplate: JSON.stringify({}),
                generateStringKey: 'secret'
            }
        });

        // 2) Aurora MySQL cluster
        this.dbCluster = new DatabaseCluster(this, 'ScaleliteDB', {
            engine: DatabaseClusterEngine.auroraMysql({
                version: AuroraMysqlEngineVersion.VER_2_11_1
            }),
            credentials: Credentials.fromGeneratedSecret('scalelite_admin'),
            instances: 2,
            defaultDatabaseName: 'scalelite_production',
            instanceProps: {
                vpc: props.vpc,
                vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS }
            }
        });

        // 3) Redis subnet group + cluster
        const subnetGroup = new CfnSubnetGroup(this, 'RedisSubnetGroup', {
            description: 'Subnet group for Scalelite Redis',
            subnetIds: props.vpc
                .selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })
                .subnetIds,
            cacheSubnetGroupName: 'scalelite-redis-subnets'
        });

        this.redisSg = new SecurityGroup(this, 'RedisSG', {
            vpc: props.vpc,
            description: 'Security Group for Scalelite Redis',
            allowAllOutbound: true
        });

        const redis = new CfnCacheCluster(this, 'ScaleliteRedis', {
            engine: 'redis',
            cacheNodeType: props.redisInstanceType || 'cache.t3.micro',
            numCacheNodes: 1,
            cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
            vpcSecurityGroupIds: [this.redisSg.securityGroupId]
        });
        this.redisEndpoint = redis.attrRedisEndpointAddress;
    }
}
