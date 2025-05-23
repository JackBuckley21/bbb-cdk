import 'source-map-support/register';
import { App, Stack } from 'aws-cdk-lib';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { DatabaseStack } from '../lib/database-stack';
import { ScaleliteStack } from '../lib/scalelite-stack';
import { BbbClusterStack } from '../lib/bbb-cluster-stack';

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT!;
const region  = process.env.CDK_DEFAULT_REGION!;

const lookup = new Stack(app, 'VpcLookupStack', {
    env: { account, region }
});
const vpc = Vpc.fromLookup(lookup, 'DevVPC', {
    vpcName: 'my-dev-vpc'
});

const databaseStack = new DatabaseStack(app, 'DatabaseStack', {
    vpc,
    env: { account, region }
});

const scaleliteStack = new ScaleliteStack(app, 'ScaleliteStack', {
    vpc,
    dbCluster:      databaseStack.dbCluster,
    redisEndpoint:  databaseStack.redisEndpoint,
    sharedSecret:   databaseStack.sharedSecret,
    domainName:     'example.com',
    certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abcdefg',
    env: { account, region }
});

new BbbClusterStack(app, 'BbbClusterStack', {
    vpc,
    scaleliteEndpoint: scaleliteStack.apiEndpoint,
    sharedSecret:      databaseStack.sharedSecret,
    keyName:           'dev-ssh-key',
    env: { account, region }
});
