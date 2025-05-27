import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  IVpc, SubnetType, SecurityGroup, Peer, Port,
  InstanceType, InstanceClass, InstanceSize,
  MachineImage, UserData, LaunchTemplate, InterfaceVpcEndpointAwsService
} from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
// Removed specific import for SpotMarketType as namespace import 'autoscaling' is used.
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda'; // Keep for Runtime
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'node:path';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as hookTargets from 'aws-cdk-lib/aws-autoscaling-hooktargets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';

export interface BbbClusterStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly scaleliteEndpoint: string;
  readonly sharedSecret: Secret;
  readonly keyName?: string;
  readonly bbbInstanceType?: InstanceType;
  readonly useSpotInstances?: boolean;
  readonly sshAllowedCidr: string; // Made mandatory
}

export class BbbClusterStack extends Stack {
  public readonly criticalAlarmsTopic: sns.ITopic;

  constructor(scope: Construct, id: string, props: BbbClusterStackProps) {
    super(scope, id, props);

    // Create an SNS topic for critical alarms
    this.criticalAlarmsTopic = new sns.Topic(this, 'CriticalAlarmsTopic', {
      displayName: 'Critical Alarms for BBB and Scalelite Infrastructure',
    });

    // TODO: For enhanced security, consider adding VPC Endpoints for EC2, Auto Scaling, and SNS
    // to keep AWS API calls within the VPC, reducing exposure to the public internet.
    // e.g., props.vpc.addInterfaceEndpoint('EC2Endpoint', { service: InterfaceVpcEndpointAwsService.EC2 });
    // e.g., props.vpc.addInterfaceEndpoint('AutoScalingEndpoint', { service: InterfaceVpcEndpointAwsService.AUTOSCALING });
    // e.g., props.vpc.addInterfaceEndpoint('SNSEndpoint', { service: InterfaceVpcEndpointAwsService.SNS });
    // Note: Adding these endpoints may have cost implications.

    const bbbSg = new SecurityGroup(this, 'BBB-SG', {
      vpc: props.vpc,
      description: 'Allow SSH, HTTP/S, WebRTC',
      allowAllOutbound: true
    });
    // SSH access is now mandatory via context variable `sshAllowedCidr`.
    const sshPeer = Peer.ipv4(props.sshAllowedCidr);
    bbbSg.addIngressRule(sshPeer, Port.tcp(22), `SSH access from ${props.sshAllowedCidr}`);
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
        // The following command retrieves the shared secret from AWS Secrets Manager.
        // This means the secret's value is passed as a command-line argument to `scalelite-bbb-manager register`.
        // While this is a common pattern for UserData scripts, be aware that the secret value is momentarily
        // present in the instance's process environment.
        // A potential future enhancement could involve modifying `scalelite-bbb-manager` to use the instance
        // profile directly to fetch the secret at the time of registration, if supported,
        // rather than receiving it as a command-line argument.

        // Robustness of Scalelite Registration:
        // The current UserData script attempts to register the BBB server with Scalelite a single
        // time upon instance boot. This approach has limitations:
        //   - Transient network issues between the BBB server and the Scalelite endpoint during this
        //     initial registration attempt can cause the registration to fail.
        //   - If the Scalelite service is temporarily unavailable or restarting when the BBB
        //     instance boots, the registration will also fail.
        //   - A failed registration means the new BBB server will not be added to the Scalelite pool
        //     and will not serve any meetings, effectively being an underutilized resource.
        //
        // Future Enhancements for Improved Robustness:
        // 1. Retry Loop in UserData:
        //    Implement a retry mechanism directly in this UserData script for the
        //    `scalelite-bbb-manager register` command.
        //    Example (bash pseudo-code integrated into UserData string):
        //    MAX_RETRIES=5
        //    RETRY_DELAY=60 # seconds
        //    RETRY_COUNT=0
        //    REGISTRATION_SUCCESSFUL=false
        //    while [ $RETRY_COUNT -lt $MAX_RETRIES ] && [ "$REGISTRATION_SUCCESSFUL" = false ]; do
        //      echo "Attempting Scalelite registration (Attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)..."
        //      # Note: The actual command below needs to be correctly formatted within this UserData script.
        //      if scalelite-bbb-manager register ${props.scaleliteEndpoint.replace('https://', '')} --secret $(aws secretsmanager get-secret-value --secret-id ${props.sharedSecret.secretArn} --query SecretString --output text --region ${this.region} | jq -r .secret); then
        //        REGISTRATION_SUCCESSFUL=true
        //        echo "Scalelite registration successful."
        //      else
        //        RETRY_COUNT=$((RETRY_COUNT + 1))
        //        echo "Scalelite registration failed. Retrying in $RETRY_DELAY seconds..."
        //        sleep $RETRY_DELAY
        //      fi
        //    done
        //    if [ "$REGISTRATION_SUCCESSFUL" = false ]; then
        //      echo "Critical: Scalelite registration failed after $MAX_RETRIES attempts. Instance may not function correctly."
        //      # Consider further actions here, like instance self-termination or error reporting to CloudWatch Logs.
        //    fi
        //    # Fall-through: if successful, UserData continues. If failed, it has been logged.
        //
        // 2. ASG Custom Health Check:
        //    Develop a custom health check for the Auto Scaling Group. This involves:
        //    a. The BBB instance running a simple HTTP server (e.g., on localhost via systemd service)
        //       or writing a status file (e.g., /var/run/scalelite-registration-status).
        //    b. This status endpoint or file would indicate 'healthy' only if `scalelite-bbb-manager register`
        //       was successful (and perhaps if `bbb-conf --status` is okay).
        //    c. Configure the ASG health check (ELB health check if ASG is behind ELB, or EC2 health check type)
        //       to target this local status. If the check fails, the ASG can automatically terminate the
        //       unhealthy instance and launch a replacement.
        //
        // 3. Persistent Registration Daemon/Scheduled Task:
        //    Implement a small daemon (e.g., a systemd service unit) or a cron job on the BBB instance.
        //    This task would:
        //    a. Periodically check if the server is registered with Scalelite. This could be done by:
        //       - Having `scalelite-bbb-manager` write a status file upon successful registration, which the daemon checks.
        //       - (More complex) Querying the Scalelite `getServers` API. This might require the instance role
        //         to have permissions to fetch the shared secret for API calls, or use a long-lived token if available.
        //    b. If not registered (or status indicates deregistered), attempt the `scalelite-bbb-manager register` command.
        //    c. This ensures that even if registration fails initially or if the server is somehow deregistered,
        //       it will attempt to re-register.
        //    d. Optionally, this daemon could publish custom CloudWatch metrics indicating registration status,
        //       allowing for alarms on persistent registration failures.
        //
        // Choosing the right strategy depends on the desired level of resilience and complexity.
        // A combination, like a UserData retry loop plus ASG health checks, can be very effective.
        // For now, the script proceeds with a single registration attempt.
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
        marketType: autoscaling.SpotMarketType.SPOT, // Changed to use namespace
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

    const asg = new autoscaling.AutoScalingGroup(this, 'BBBASG', asgProps); // Changed to use namespace
    props.sharedSecret.grantRead(asg.role); // Grant ASG role permission to read the secret

    // CPU-based target tracking scaling policy
    asg.scaleOnCpuUtilization('BBBCpuScaling', {
      targetUtilizationPercent: 70,
      // Scale out if CPU > 70%.
      // Scale in if CPU < 70% (this is implicit with target tracking).
      // The specific 30% scale-in threshold from the requirement is not directly achievable
      // with a single scaleOnCpuUtilization call maintaining a single target.
      // This method aims to keep utilization AT the targetUtilizationPercent.

      scaleInCooldown: Duration.seconds(300),
      scaleOutCooldown: Duration.seconds(300),

      // The "sustained period" for alarms (e.g., 5 min for scale-out, 10 min for scale-in)
      // is determined by the CloudWatch Alarms' EvaluationPeriods and Period.
      // The scaleOnCpuUtilization construct creates these alarms with default settings
      // for these properties, which are typically reasonable (e.g., 3 evaluation periods of 1 or 5 minutes).
      // If precise control over alarm evaluation periods (5 min vs 10 min) is critical
      // and different from CDK defaults, a more manual setup with separate Alarm
      // and StepScalingPolicy/TargetTrackingScalingPolicy constructs would be needed.
      // Given the instruction to use scaleOnCpuUtilization, we rely on its standard behavior.
    });

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

    // Create VPC Endpoint for Secrets Manager to allow Lambda to access it privately
    const secretsManagerEndpoint = props.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS }, // Deploy endpoint in private subnets
      privateDnsEnabled: true, // Default, allows using standard DNS name
    });

    const lambdaSg = new SecurityGroup(this, 'DeregisterLambdaSG', {
        vpc: props.vpc,
        description: 'Security Group for Deregistration Lambda',
        allowAllOutbound: false // Be specific with outbound rules
    });

    // Allow Lambda to connect to the Secrets Manager VPC endpoint
    secretsManagerEndpoint.connections.allowDefaultPortFrom(lambdaSg, 'Allow Lambda to access Secrets Manager Endpoint');

    // Allow outbound to Scalelite ALB (HTTPS typically)
    // TODO: This rule is broad (entire VPC CIDR). For tighter security, if ScaleliteStack is in the same app,
    // pass the Scalelite ALB's security group as a prop to BbbClusterStack and use it as the peer.
    // e.g., lambdaSg.addEgressRule(props.scaleliteAlbSg, Port.tcp(443), 'Allow outbound to Scalelite ALB');
    // If cross-stack SG reference is not feasible, consider restricting to Scalelite's IP if static, or a narrower subnet.
    lambdaSg.addEgressRule(Peer.ipv4(props.vpc.vpcCidrBlock), Port.tcp(443), 'Allow outbound to Scalelite ALB (within VPC)');


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
      notificationTarget: new hookTargets.SnsTopicTarget(lifecycleTopic), // Corrected to SnsTopicTarget
      defaultResult: autoscaling.DefaultResult.ABANDON, // Abandon if Lambda fails or times out
      heartbeatTimeout: Duration.minutes(5),
    });

    // --- Critical Alarms Setup ---

    // 1. BBB ASG High CPU Utilization Alarm
    const bbbAsgHighCpuAlarm = new cloudwatch.Alarm(this, 'BBBASGHighCPUAlarm', {
      alarmName: 'BBBASGHighCPUAlarm',
      alarmDescription: 'Triggers if the BBB Auto Scaling Group average CPU utilization exceeds 85% for 15 minutes.',
      metric: asg.metricCpuUtilization({
        period: Duration.minutes(5),
        statistic: cloudwatch.Statistic.AVERAGE,
      }),
      threshold: 85,
      evaluationPeriods: 3, // 3 * 5 minutes = 15 minutes
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // Or as appropriate
    });
    bbbAsgHighCpuAlarm.addAlarmAction(new cw_actions.SnsAction(this.criticalAlarmsTopic));

    // 2. Deregister Lambda Errors Alarm
    const deregisterLambdaErrorsAlarm = new cloudwatch.Alarm(this, 'DeregisterLambdaErrorsAlarm', {
      alarmName: 'DeregisterLambdaErrorsAlarm',
      alarmDescription: 'Triggers if the Deregister Lambda function has errors.',
      metric: deregisterLambda.metricErrors({
        period: Duration.minutes(5),
        statistic: cloudwatch.Statistic.SUM,
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    deregisterLambdaErrorsAlarm.addAlarmAction(new cw_actions.SnsAction(this.criticalAlarmsTopic));

    // 3. Deregister Lambda Timeouts Alarm
    // Using the 'Timeouts' metric directly from AWS/Lambda namespace
    const deregisterLambdaTimeoutsAlarm = new cloudwatch.Alarm(this, 'DeregisterLambdaTimeoutsAlarm', {
        alarmName: 'DeregisterLambdaTimeoutsAlarm',
        alarmDescription: 'Triggers if the Deregister Lambda function times out.',
        metric: deregisterLambda.metric('Timeouts', { // This uses the AWS/Lambda.Timeouts metric
            period: Duration.minutes(5),
            statistic: cloudwatch.Statistic.SUM,
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    deregisterLambdaTimeoutsAlarm.addAlarmAction(new cw_actions.SnsAction(this.criticalAlarmsTopic));

    // Recommendation for Application-Level Metrics:
    // Consider implementing application-level metrics for more nuanced monitoring.
    // For BBB instances, this could include active users, active meetings, or specific error rates from logs.
    // These custom metrics can be published to CloudWatch using the AWS SDK or CloudWatch Agent
    // and then alarmed upon, providing deeper insights into application health beyond infrastructure metrics.
  }
}
