import 'source-map-support/register';
import { App, Stack } from 'aws-cdk-lib';
import { Vpc, InstanceType, InstanceClass, InstanceSize } from 'aws-cdk-lib/aws-ec2';
import { DatabaseStack } from '../lib/database-stack';
import { ScaleliteStack } from '../lib/scalelite-stack';
import { BbbClusterStack } from '../lib/bbb-cluster-stack';

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT!;
const region  = process.env.CDK_DEFAULT_REGION!;

// Context variables
const vpcName        = app.node.tryGetContext('vpcName')        || 'my-dev-vpc';
const domainName     = app.node.tryGetContext('domainName');
if (!domainName) throw new Error("Context variable 'domainName' is required.");
const certificateArn = app.node.tryGetContext('certificateArn');
if (!certificateArn) throw new Error("Context variable 'certificateArn' is required.");
const bbbKeyName     = app.node.tryGetContext('bbbKeyName');    // Optional
const sshAllowedCidr = app.node.tryGetContext('sshAllowedCidr');
if (!sshAllowedCidr) throw new Error("Context variable 'sshAllowedCidr' is required.");

const lookup = new Stack(app, 'VpcLookupStack', { env: { account, region } });
const vpc    = Vpc.fromLookup(lookup, 'DevVPC', { vpcName });

const databaseStack = new DatabaseStack(app, 'DatabaseStack', {
    vpc,
    redisInstanceType: 'cache.t3.small',
    env: { account, region }
});

const scaleliteStack = new ScaleliteStack(app, 'ScaleliteStack', {
    vpc,
    dbCluster:          databaseStack.dbCluster,
    redisEndpoint:      databaseStack.redisEndpoint,
    redisSecurityGroup: databaseStack.redisSg,
    sharedSecret:       databaseStack.sharedSecret,
    domainName,
    certificateArn,
    env: { account, region }
});

new BbbClusterStack(app, 'BbbClusterStack', {
    vpc,
    scaleliteEndpoint:              scaleliteStack.apiEndpoint,
    sharedSecret:                   databaseStack.sharedSecret,
    keyName:                        bbbKeyName,
    bbbInstanceType:                InstanceType.of(InstanceClass.M5, InstanceSize.LARGE),
    useSpotInstances:               true,
    sshAllowedCidr,

    scaleliteAlb5xxErrorsAlarm:     scaleliteStack.scaleliteAlb5xxErrorsAlarm,
    scaleliteServiceHighCPUAlarm:   scaleliteStack.scaleliteServiceHighCPUAlarm,
    scaleliteServiceHighMemoryAlarm:scaleliteStack.scaleliteServiceHighMemoryAlarm,
    env: { account, region }
});
