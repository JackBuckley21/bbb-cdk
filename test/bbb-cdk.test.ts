import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Vpc, InstanceType, InstanceClass, InstanceSize } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { BbbClusterStack } from '../lib/bbb-cluster-stack'; // Adjust path if necessary

test('BBB Cluster Stack Synthesizes with On-Demand Instances', () => {
  const app = new cdk.App();
  const parentStack = new cdk.Stack(app, "ParentTestStackOD", {
    env: { account: '123456789012', region: 'us-east-1' } // Specify env for region-dependent lookups like SSM
  });

  // Create a dummy VPC for the test
  const vpc = new Vpc(parentStack, 'TestVPCOD');

  // Create a dummy Secret for the test
  const sharedSecret = new Secret(parentStack, 'TestSharedSecretOD', {
    secretObjectValue: {
      secret: cdk.SecretValue.unsafePlainText('dummy-secret-value')
    }
  });

  // Instantiate the BbbClusterStack for On-Demand
  const bbbClusterStack = new BbbClusterStack(app, 'MyTestBbbClusterStackOD', {
    vpc: vpc,
    scaleliteEndpoint: 'https://scalelite.example.com/bigbluebutton/api',
    sharedSecret: sharedSecret,
    keyName: 'test-key',
    bbbInstanceType: InstanceType.of(InstanceClass.T3, InstanceSize.SMALL),
    useSpotInstances: false,
    sshAllowedCidr: '10.0.0.0/24',
    env: { account: '123456789012', region: 'us-east-1' }
  });

  // Prepare the stack for assertions.
  const template = Template.fromStack(bbbClusterStack);

  // Assertion: Check if an AutoScalingGroup resource is created
  template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);

  // Assertion: Check if a LaunchTemplate is created
  template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);

  // Assertion: Check if required SecurityGroups are created (BBB SG, Lambda SG)
  template.resourceCountIs('AWS::EC2::SecurityGroup', 2); 
  
  // Check for Lifecycle Hook
  template.resourceCountIs('AWS::AutoScaling::LifecycleHook', 1);

  // Check for Lambda Function (for deregistration)
  template.resourceCountIs('AWS::Lambda::Function', 1);
  
  // Check for SNS Topic
  template.resourceCountIs('AWS::SNS::Topic', 1);

  // Check that ASG does NOT have InstanceMarketOptions for On-Demand
  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    LaunchTemplateSpecification: Match.anyValue(), // Basic check
    InstanceMarketOptions: Match.absent() // Should not be present for on-demand
  });
});


test('BBB Cluster Stack Synthesizes with Spot Instances', () => {
  const app = new cdk.App();
  const parentStack = new cdk.Stack(app, "ParentTestStackSpot", {
    env: { account: '123456789012', region: 'us-east-1' } // Specify env
  });
  const vpc = new Vpc(parentStack, 'TestVPCSpot');
  const sharedSecret = new Secret(parentStack, 'TestSharedSecretSpot', {
    secretObjectValue: {
      secret: cdk.SecretValue.unsafePlainText('dummy-secret-value')
    }
  });

  // Instantiate the BbbClusterStack for Spot Instances
  const spotBbbClusterStack = new BbbClusterStack(app, 'MySpotTestBbbClusterStack', {
    vpc: vpc,
    scaleliteEndpoint: 'https://scalelite.example.com/bigbluebutton/api',
    sharedSecret: sharedSecret,
    keyName: 'test-key-spot',
    bbbInstanceType: InstanceType.of(InstanceClass.T3, InstanceSize.SMALL),
    useSpotInstances: true, // Enable spot instances
    sshAllowedCidr: '10.0.0.1/32',
    env: { account: '123456789012', region: 'us-east-1' }
  });

  const spotTemplate = Template.fromStack(spotBbbClusterStack);

  // Check if an AutoScalingGroup resource is created
  spotTemplate.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);

  // Check if the ASG has InstanceMarketOptions property when useSpotInstances is true
  spotTemplate.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    LaunchTemplateSpecification: Match.anyValue(), // Basic check
    InstanceMarketOptions: {
      MarketType: 'spot',
      // SpotOptions: Match.anyValue() // SpotOptions can be checked if specific values are set
    }
  });

  // Verify other relevant resources are also created in Spot scenario
  spotTemplate.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
  spotTemplate.resourceCountIs('AWS::EC2::SecurityGroup', 2); // BBB SG, Lambda SG
  spotTemplate.resourceCountIs('AWS::AutoScaling::LifecycleHook', 1);
  spotTemplate.resourceCountIs('AWS::Lambda::Function', 1);
  spotTemplate.resourceCountIs('AWS::SNS::Topic', 1);
});
