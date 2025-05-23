import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  IVpc, SubnetType, SecurityGroup, Peer, Port,
  InstanceType, InstanceClass, InstanceSize,
  MachineImage, UserData, LaunchTemplate
} from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { SpotMarketType } from 'aws-cdk-lib/aws-autoscaling';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda'; // Keep for Runtime
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'node:path';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as hookTargets from 'aws-cdk-lib/aws-autoscaling-hooktargets';

export interface BbbClusterStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly scaleliteEndpoint: string;
  readonly sharedSecret: Secret;
  readonly keyName?: string;
  readonly bbbInstanceType?: InstanceType;
  readonly useSpotInstances?: boolean;
  readonly sshAllowedCidr?: string;
}

export class BbbClusterStack extends Stack {
  constructor(scope: Construct, id: string, props: BbbClusterStackProps) {
    super(scope, id, props);

    const bbbSg = new SecurityGroup(this, 'BBB-SG', {
      vpc: props.vpc,
      description: 'Allow SSH, HTTP/S, WebRTC',
      allowAllOutbound: true
    });
    // SSH access is configurable. Defaults to Peer.anyIpv4() if sshAllowedCidr is not provided.
    // For production, it is highly recommended to restrict this to a specific IP range.
    const sshPeer = props.sshAllowedCidr ? Peer.ipv4(props.sshAllowedCidr) : Peer.anyIpv4();
    bbbSg.addIngressRule(sshPeer, Port.tcp(22), `SSH access ${props.sshAllowedCidr ? `from ${props.sshAllowedCidr}` : '(open to all - consider restricting)'}`);
    bbbSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'HTTP');
    bbbSg.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS');
    bbbSg.addIngressRule(Peer.anyIpv4(), Port.udpRange(16384, 32768), 'WebRTC');

    const ami = MachineImage.fromSsmParameter(
        new StringParameter(this, 'UbuntuAmiParam', {
          stringValue: "",
          parameterName:
              '/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
        }).stringValue
    );

    const userData = UserData.forLinux();
    userData.addCommands(
        'apt-get update -y && apt-get install -y jq awscli', // Ensure jq and awscli are installed
        'wget -qO- https://ubuntu.bigbluebutton.org/bbb-install.sh | bash -s -- -v focal-270 -y',
        `scalelite-bbb-manager register ${props.scaleliteEndpoint.replace(
            'https://', ''
        )} --secret $(aws secretsmanager get-secret-value --secret-id ${props.sharedSecret.secretArn} --query SecretString --output text --region ${this.region} | jq -r .secret)`
    );

    const lt = new LaunchTemplate(this, 'BBBLaunchTemplate', {
      machineImage: ami,
      instanceType: props.bbbInstanceType || InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
      securityGroup: bbbSg,
      keyName: props.keyName,
      userData
    });

    const asgProps = {
      vpc: props.vpc,
      launchTemplate: lt,
      minCapacity: 1,
      maxCapacity: 5,
      vpcSubnets: { subnetType: SubnetType.PUBLIC }
    };

    if (props.useSpotInstances) {
      (asgProps as any).instanceMarketOptions = {
        marketType: SpotMarketType.SPOT,
        // Optionally, set spotOptions for maxPrice, interruption behavior etc.
        // spotOptions: {
        //   maxPrice: '0.10', // Example: Set max hourly price
        //   spotInstanceType: SpotInstanceType.ONE_TIME,
        //   instanceInterruptionBehavior: InstanceInterruptionBehavior.TERMINATE,
        // },
      };
      // For better Spot resilience, consider using mixedInstancesPolicy
      // to diversify across multiple instance types.
    }

    const asg = new AutoScalingGroup(this, 'BBBASG', asgProps);
    props.sharedSecret.grantRead(asg.role); // Grant ASG role permission to read the secret

    // --- Lifecycle Hook Setup ---

    const lifecycleTopic = new sns.Topic(this, 'LifecycleSNSTopic');

    const lambdaRole = new iam.Role(this, 'DeregisterLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole') // For VPC access
      ],
    });

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ec2:DescribeTags'], // To get instance details if needed
      resources: ['*'], // Can be scoped down if specific tag-based lookups are used
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['autoscaling:CompleteLifecycleAction'],
      resources: [`arn:aws:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${asg.autoScalingGroupName}`],
    }));


    const lambdaSg = new SecurityGroup(this, 'DeregisterLambdaSG', {
        vpc: props.vpc,
        description: 'Security Group for Deregistration Lambda',
        allowAllOutbound: false // Be specific with outbound rules
    });
    // Allow outbound to Scalelite ALB (HTTPS typically) - Assuming Scalelite ALB SG is known or tagged
    // For now, allowing to VPC CIDR as a placeholder. This should be refined.
    // e.g., lambdaSg.addEgressRule(Peer.ipv4(props.vpc.vpcCidrBlock), Port.tcp(443), 'Allow outbound to Scalelite ALB');
    // Allow outbound to Secrets Manager VPC Endpoint (HTTPS)
    lambdaSg.addEgressRule(Peer.prefixList('pl-08b2fac53EXAMPLE'), Port.tcp(443), 'Allow outbound to Secrets Manager VPC Endpoint'); // Replace with actual prefix list for your region if possible, or use VPC CIDR for endpoint.

    // The Python inline code and old lambda.Function definition are removed from here.

    const deregisterLambda = new NodejsFunction(this, 'DeregisterLambdaHandler', {
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: path.join(__dirname, '../../src/lambda-handlers/deregister-bbb-server.ts'),
        handler: 'handler',
        environment: {
            SCALELITE_API_BASE_URL: `${props.scaleliteEndpoint}/scalelite/api`,
            SHARED_SECRET_ARN: props.sharedSecret.secretArn,
            AWS_REGION: this.region,
        },
        role: lambdaRole,
        vpc: props.vpc,
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [lambdaSg],
        timeout: Duration.minutes(3),
        bundling: {
            externalModules: [
                '@aws-sdk/client-secrets-manager',
                '@aws-sdk/client-ec2',
                '@aws-sdk/client-auto-scaling',
                // 'axios' should be bundled by default if it's a dependency in package.json
            ],
            // Ensure esbuild is used if not default, or configure other options as needed
        },
    });
    // Grant the new Lambda function permission to read the secret
    props.sharedSecret.grantRead(deregisterLambda);

    deregisterLambda.addEventSource(new lambdaEventSources.SnsEventSource(lifecycleTopic));

    asg.addLifecycleHook('TerminateHook', {
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      notificationTarget: new hookTargets.SnsTopic(lifecycleTopic),
      defaultResult: autoscaling.DefaultResult.ABANDON, // Abandon if Lambda fails or times out
      heartbeatTimeout: Duration.minutes(5),
    });
  }
}
