import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Alarm } from 'aws-cdk-lib/aws-cloudwatch';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';

export interface BbbClusterStackProps extends StackProps {
    readonly vpc: ec2.IVpc;
    readonly scaleliteEndpoint: string;
    readonly sharedSecret: Secret;
    readonly keyName?: string;
    readonly bbbInstanceType?: ec2.InstanceType;
    readonly useSpotInstances?: boolean;
    readonly sshAllowedCidr: string;

    readonly scaleliteAlb5xxErrorsAlarm: Alarm;
    readonly scaleliteServiceHighCPUAlarm:   Alarm;
    readonly scaleliteServiceHighMemoryAlarm: Alarm;
}

export class BbbClusterStack extends Stack {
    public readonly criticalAlarmsTopic: sns.ITopic;

    constructor(scope: Construct, id: string, props: BbbClusterStackProps) {
        super(scope, id, props);

        // 1) SNS topic for critical alarms
        this.criticalAlarmsTopic = new sns.Topic(this, 'CriticalAlarmsTopic', {
            displayName: 'Critical Alarms for BBB and Scalelite Infrastructure',
        });

        // 2) Subscribe all three Scalelite alarms to this topic
        props.scaleliteAlb5xxErrorsAlarm.addAlarmAction(
            new cw_actions.SnsAction(this.criticalAlarmsTopic)
        );
        props.scaleliteServiceHighCPUAlarm.addAlarmAction(
            new cw_actions.SnsAction(this.criticalAlarmsTopic)
        );
        props.scaleliteServiceHighMemoryAlarm.addAlarmAction(
            new cw_actions.SnsAction(this.criticalAlarmsTopic)
        );

        // 3) Security group for BBB nodes
        const bbbSg = new ec2.SecurityGroup(this, 'BBB-SG', {
            vpc: props.vpc,
            description: 'Allow SSH, HTTP/S, WebRTC',
            allowAllOutbound: true,
        });
        bbbSg.addIngressRule(ec2.Peer.ipv4(props.sshAllowedCidr), ec2.Port.tcp(22), 'SSH');
        bbbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
        bbbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
        bbbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udpRange(16384, 32768), 'WebRTC');

        // 4) EC2 role & instance profile for BBB servers
        const instanceRole = new iam.Role(this, 'BBBInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
            ],
        });

        // 5) Reference the Canonical Ubuntu AMI via SSM
        const ami = ec2.MachineImage.fromSsmParameter(
            '/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
        );

        // 6) UserData: install BBB & register with Scalelite
        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            'apt-get update -y && apt-get install -y jq awscli',
            'wget -qO- https://ubuntu.bigbluebutton.org/bbb-install.sh | bash -s -- -v focal-270 -y',
            `scalelite-bbb-manager register ${props.scaleliteEndpoint.replace('https://','')} \
--secret $(aws secretsmanager get-secret-value --secret-id ${props.sharedSecret.secretArn} \
--query SecretString --output text --region ${this.region} | jq -r .secret)`
        );

        // 7) LaunchTemplate (attach our EC2 role, and numeric maxPrice if using Spot)
        const lt = new ec2.LaunchTemplate(this, 'BBBLaunchTemplate', {
            machineImage: ami,
            instanceType: props.bbbInstanceType
                ?? ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            securityGroup: bbbSg,
            keyName: props.keyName,
            userData,
            role: instanceRole,
            ...(props.useSpotInstances
                ? {
                    spotOptions: {
                        maxPrice: 0.05,
                        interruptionBehavior: ec2.SpotInstanceInterruption.TERMINATE,
                    },
                }
                : {}),
        });

        // 8) AutoScalingGroup using that LaunchTemplate
        const asg = new autoscaling.AutoScalingGroup(this, 'BBBASG', {
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            launchTemplate: lt,
            minCapacity: 1,
            maxCapacity: 5,
        });

        // 9) Grant the EC2 role permission to read the shared secret
        props.sharedSecret.grantRead(instanceRole);

        // 10) Target‐tracking scaling on CPU
        asg.scaleOnCpuUtilization('BBBCpuScaling', {
            targetUtilizationPercent: 70,
            cooldown: Duration.seconds(300),
        });

        // 11) CloudWatch alarm on ASG CPU > 85% for 15 minutes
        const cpuMetric = new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'CPUUtilization',
            statistic: 'Average',
            period: Duration.minutes(5),
            dimensionsMap: {
                AutoScalingGroupName: asg.autoScalingGroupName,
            },
        });

        const highCpuAlarm = new Alarm(this, 'HighCpuAlarm', {
            metric: cpuMetric,
            threshold: 85,
            evaluationPeriods: 3,
            comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        highCpuAlarm.addAlarmAction(new cw_actions.SnsAction(this.criticalAlarmsTopic));
    }
}
