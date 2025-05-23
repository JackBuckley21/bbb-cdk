// lib/bbb-cluster-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  IVpc, SubnetType, SecurityGroup, Peer, Port,
  InstanceType, InstanceClass, InstanceSize,
  MachineImage, UserData, LaunchTemplate
} from 'aws-cdk-lib/aws-ec2';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

export interface BbbClusterStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly scaleliteEndpoint: string; // e.g. "https://bbb.example.com"
  readonly sharedSecret: Secret;
  readonly keyName?: string;
}

export class BbbClusterStack extends Stack {
  constructor(scope: Construct, id: string, props: BbbClusterStackProps) {
    super(scope, id, props);

    const bbbSg = new SecurityGroup(this, 'BBB-SG', {
      vpc: props.vpc,
      description: 'Allow SSH, HTTP/S, WebRTC',
      allowAllOutbound: true
    });
    bbbSg.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'SSH');
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
        'wget -qO- https://ubuntu.bigbluebutton.org/bbb-install.sh | bash -s -- -v focal-270 -y',
        `scalelite-bbb-manager register ${props.scaleliteEndpoint.replace(
            'https://', ''
        )} --secret ${props.sharedSecret.secretValue.toString()}`
    );

    const lt = new LaunchTemplate(this, 'BBBLaunchTemplate', {
      machineImage: ami,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
      securityGroup: bbbSg,
      keyName: props.keyName,
      userData
    });

    new AutoScalingGroup(this, 'BBBASG', {
      vpc: props.vpc,
      launchTemplate: lt,
      minCapacity: 1,
      maxCapacity: 5,
      vpcSubnets: { subnetType: SubnetType.PUBLIC }
    });
  }
}
