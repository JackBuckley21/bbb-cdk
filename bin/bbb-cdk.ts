import 'source-map-support/register';
import { App, Stack } from 'aws-cdk-lib';
import { Vpc, InstanceType, InstanceClass, InstanceSize } from 'aws-cdk-lib/aws-ec2';
import { DatabaseStack } from '../lib/database-stack';
import { ScaleliteStack } from '../lib/scalelite-stack';
import { BbbClusterStack } from '../lib/bbb-cluster-stack';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT!;
const region  = process.env.CDK_DEFAULT_REGION!;

// Context variables
const vpcName = app.node.tryGetContext('vpcName') || 'my-dev-vpc';
const domainName = app.node.tryGetContext('domainName');
if (!domainName) {
    throw new Error("Context variable 'domainName' is required. Please set it in cdk.json or via --context.");
}
const certificateArn = app.node.tryGetContext('certificateArn');
if (!certificateArn) {
    throw new Error("Context variable 'certificateArn' is required. Please set it in cdk.json or via --context.");
}
const bbbKeyName = app.node.tryGetContext('bbbKeyName'); // Optional

// sshAllowedCidr is now a required context variable for enhanced security.
const sshAllowedCidr = app.node.tryGetContext('sshAllowedCidr');
if (!sshAllowedCidr) {
    throw new Error("Context variable 'sshAllowedCidr' is required. Please set it in cdk.json or via --context (e.g., '1.2.3.4/32'). This restricts SSH access to the BBB instances.");
}

const lookup = new Stack(app, 'VpcLookupStack', {
    env: { account, region }
});
const vpc = Vpc.fromLookup(lookup, 'DevVPC', {
    vpcName: vpcName
});

const databaseStack = new DatabaseStack(app, 'DatabaseStack', {
    vpc,
    redisInstanceType: 'cache.t3.small', // This could also be a context variable if needed
    env: { account, region }
});

const scaleliteStack = new ScaleliteStack(app, 'ScaleliteStack', {
    vpc,
    dbCluster:          databaseStack.dbCluster,
    redisEndpoint:      databaseStack.redisEndpoint,
    redisSecurityGroup: databaseStack.redisSg,
    sharedSecret:       databaseStack.sharedSecret,
    domainName:         domainName,
    certificateArn:     certificateArn,
    env: { account, region }
});

const bbbClusterStack = new BbbClusterStack(app, 'BbbClusterStack', {
    vpc,
    scaleliteEndpoint: scaleliteStack.apiEndpoint,
    sharedSecret:      databaseStack.sharedSecret,
    keyName:           bbbKeyName,
    bbbInstanceType:   InstanceType.of(InstanceClass.M5, InstanceSize.LARGE), // Could be context variable
    useSpotInstances:  true, // Could be context variable
    sshAllowedCidr:    sshAllowedCidr,
    env: { account, region }
});

// Connect Scalelite alarms to the CriticalAlarmsTopic from BbbClusterStack
const criticalAlarmsTopic = bbbClusterStack.criticalAlarmsTopic;

scaleliteStack.scaleliteAlb5xxErrorsAlarm.addAlarmAction(new cw_actions.SnsAction(criticalAlarmsTopic));
scaleliteStack.scaleliteServiceHighCPUAlarm.addAlarmAction(new cw_actions.SnsAction(criticalAlarmsTopic));
scaleliteStack.scaleliteServiceHighMemoryAlarm.addAlarmAction(new cw_actions.SnsAction(criticalAlarmsTopic));
