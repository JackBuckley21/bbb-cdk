# AWS CDK BigBlueButton and Scalelite Deployment

This project provides an AWS Cloud Development Kit (CDK) solution for deploying a scalable and resilient BigBlueButton (BBB) environment, load-balanced by Scalelite. It leverages various AWS services to create a robust infrastructure suitable for production workloads.

## Architecture Overview

The architecture consists of the following key components:

*   **Scalelite:**
    *   Runs as an Amazon ECS Fargate service, ensuring high availability and removing the need to manage underlying EC2 instances for the load balancer.
    *   Exposed via an Application Load Balancer (ALB), which is protected by AWS WAFv2 using common AWS Managed Rules.
    *   Utilizes Amazon EFS (Elastic File System) for persistent storage of BigBlueButton recordings.
*   **BigBlueButton Cluster:**
    *   A pool of BigBlueButton servers running on Amazon EC2 instances.
    *   Managed by an Auto Scaling Group (ASG) to dynamically scale the number of BBB servers based on load.
    *   Supports the use of EC2 Spot Instances for cost-effective scaling of BBB capacity.
    *   Instances are automatically registered with Scalelite upon launch.
    *   Graceful deregistration from Scalelite during scale-in events or instance termination is handled by an ASG lifecycle hook triggering an AWS Lambda function.
*   **Database:**
    *   Amazon Aurora MySQL (via RDS) is used for the Scalelite database, providing a scalable and durable relational database.
*   **Cache:**
    *   Amazon ElastiCache for Redis is used as a caching layer for Scalelite, improving performance.
*   **Networking:**
    *   Deploys into an existing VPC (looked up by name).
    *   Utilizes public subnets for the Application Load Balancer and BBB EC2 instances (which require public IPs for direct WebRTC media or TURN connectivity).
    *   Utilizes private subnets for Fargate tasks, database, cache, and EFS mount targets for enhanced security.

## Prerequisites

Before deploying this CDK stack, ensure you have the following prerequisites in place:

*   **Existing VPC:** A Virtual Private Cloud (VPC) must exist in your AWS account in the target region. The CDK application will look up this VPC by the name specified in `cdk.json`.
*   **Registered Domain Name:** You need a registered domain name (e.g., `your.domain.com`) that you can manage via Route 53 or an external DNS provider (though Route 53 is assumed for DNS record creation for the ALB).
*   **ACM Certificate:** An SSL/TLS certificate for your domain must be provisioned in AWS Certificate Manager (ACM) in the **same region** where you intend to deploy this stack. The ARN of this certificate is required for configuration.
*   **EC2 Key Pair (Optional):** An EC2 key pair is recommended for SSH access to the BigBlueButton instances, especially for debugging purposes. The name of this key pair can be configured.
*   **AWS CLI and CDK Setup:** Ensure your AWS CLI is configured with appropriate credentials and the AWS CDK Toolkit is installed and bootstrapped for your account/region.

## Configuration

Configuration for this CDK deployment is primarily managed through the `cdk.json` file, under the `context` key. You will need to update these values to match your specific environment:

*   `vpcName`: The name of the existing VPC to deploy resources into (e.g., `"my-dev-vpc"`).
*   `domainName`: Your registered domain name where Scalelite will be accessible (e.g., `"bbb.your.domain.com"`). The A record for the Scalelite ALB will be created under this domain.
*   `certificateArn`: The full ARN of the ACM certificate for your domain (e.g., `"arn:aws:acm:us-east-1:123456789012:certificate/your-certificate-id"`).
*   `bbbKeyName` (Optional): The name of your EC2 key pair for SSH access to BBB instances (e.g., `"my-ec2-key"`). If not provided, SSH access might be more complex.
*   `sshAllowedCidr`: The CIDR block to allow SSH access to the BigBlueButton instances (e.g., `"YOUR_IP_CIDR/32"`). For security, restrict this to your IP address or a specific range. Defaults to `0.0.0.0/0` in the stack if not set, which is not recommended for production.

**Example `cdk.json` context:**
```json
{
  "context": {
    "vpcName": "my-production-vpc",
    "domainName": "conferencing.mycompany.com",
    "certificateArn": "arn:aws:acm:eu-west-1:ACCOUNTID:certificate/CERTIFICATEID",
    "bbbKeyName": "production-bbb-key",
    "sshAllowedCidr": "198.51.100.5/32"
  }
}
```

Other configurations, such as instance types for BBB servers or Redis, or desired counts for Fargate tasks, can be modified directly within the respective CDK stack files (e.g., `lib/bbb-cluster-stack.ts`, `lib/database-stack.ts`). These could be further parameterized using context variables if needed.

## Key Features

*   **Scalable BigBlueButton Cluster:** Utilizes EC2 Auto Scaling Groups to automatically adjust the number of BBB servers based on demand.
*   **Spot Instance Support:** Option to use EC2 Spot Instances for BBB servers to significantly reduce compute costs for scalable capacity.
*   **Resilient Scalelite Load Balancer:** Scalelite runs as a containerized application on AWS Fargate, managed by ECS for high availability.
*   **Persistent Recordings:** BigBlueButton recordings are stored on Amazon EFS, providing durable and shared storage accessible by Scalelite.
*   **WAF Protection:** The Scalelite Application Load Balancer is protected by AWS WAFv2 using AWS Managed Rules for common threats and IP reputation lists.
*   **Automated Server Management:**
    *   BBB servers automatically register with Scalelite on launch.
    *   Graceful deregistration of BBB servers from Scalelite during termination events is handled by ASG lifecycle hooks and an AWS Lambda function.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy --all`  deploy all stacks to your default AWS account/region (ensure context in `cdk.json` is set)
* `npx cdk deploy DatabaseStack`  deploy a specific stack
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
* `npx cdk context` list context values available to the CDK app
* `npx cdk destroy` destroy all deployed stacks (use with caution)

Make sure to review the changes with `cdk diff` before deploying.
