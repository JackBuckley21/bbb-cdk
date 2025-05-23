import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import {
    AutoScalingClient,
    CompleteLifecycleActionCommand,
} from '@aws-sdk/client-auto-scaling';
import axios, { AxiosInstance } from 'axios';
import { createHash } from 'node:crypto';
import { URLSearchParams } from 'node:url'; // Used for consistent query param sorting

// Interfaces
interface SNSEventRecordMessage {
    EC2InstanceId: string;
    LifecycleHookName: string;
    AutoScalingGroupName: string;
    // Add other fields if necessary, like LifecycleActionToken, etc.
}

interface ScaleliteServer {
    id: string;
    server_id: string; // This is typically the hostname/identifier used by BBB
    url: string;
    secret: string; // Though we don't use this specific secret from getServers
    // Add other fields if present in the getServers response
}

// Environment Variables
const SCALELITE_API_BASE_URL = process.env.SCALELITE_API_BASE_URL!;
const SHARED_SECRET_ARN = process.env.SHARED_SECRET_ARN!;
const AWS_REGION = process.env.AWS_REGION!;

if (!SCALELITE_API_BASE_URL || !SHARED_SECRET_ARN || !AWS_REGION) {
    console.error('Missing critical environment variables: SCALELITE_API_BASE_URL, SHARED_SECRET_ARN, or AWS_REGION');
    // In a real Lambda, this would cause an initialization error.
    // For local testing, you'd want to throw or exit.
    throw new Error('Missing critical environment variables.');
}

// AWS SDK Clients
const smClient = new SecretsManagerClient({ region: AWS_REGION });
const ec2Client = new EC2Client({ region: AWS_REGION });
const asClient = new AutoScalingClient({ region: AWS_REGION });

// Axios instance for HTTP requests
const httpClient: AxiosInstance = axios.create({
    timeout: 15000, // 15 seconds timeout
});

// Scalelite API Actions
const GET_SERVERS_ACTION = 'getServers';
const DELETE_SERVER_ACTION = 'deleteServer';

function getSortedQueryString(queryParams: Record<string, string>): string {
    if (Object.keys(queryParams).length === 0) {
        return "";
    }
    // URLSearchParams sorts keys automatically upon construction if given an object
    // or when iterating. For explicit alphabetical sort required by some APIs:
    const params = new URLSearchParams();
    Object.keys(queryParams).sort().forEach(key => {
        params.append(key, queryParams[key]);
    });
    return params.toString();
}

function calculateChecksum(action: string, queryParamsString: string, requestBodyString: string, sharedSecret: string): string {
    const stringToHash = action + queryParamsString + requestBodyString + sharedSecret;
    console.debug(`String to hash for checksum (${action}): ${stringToHash}`);
    return createHash('sha1').update(stringToHash).digest('hex');
}


export const handler = async (event: any): Promise<void> => {
    console.info(`Received event: ${JSON.stringify(event)}`);

    const snsMessageString = event.Records[0].Sns.Message;
    const snsMessage: SNSEventRecordMessage = JSON.parse(snsMessageString);

    const instanceId = snsMessage.EC2InstanceId;
    const lifecycleHookName = snsMessage.LifecycleHookName;
    const autoScalingGroupName = snsMessage.AutoScalingGroupName;

    let lifecycleActionResult = 'ABANDON'; // Default to ABANDON

    try {
        if (!instanceId) {
            console.error('EC2InstanceId not found in SNS message.');
            throw new Error('EC2InstanceId missing from SNS message.');
        }
        if (!lifecycleHookName || !autoScalingGroupName) {
            console.error('LifecycleHookName or AutoScalingGroupName not found in SNS message.');
            throw new Error('Lifecycle details missing from SNS message.');
        }

        // 1. Get Shared Secret from Secrets Manager
        console.info(`Fetching shared secret from ARN: ${SHARED_SECRET_ARN}`);
        const secretValueCommand = new GetSecretValueCommand({ SecretId: SHARED_SECRET_ARN });
        const secretValueOutput = await smClient.send(secretValueCommand);
        if (!secretValueOutput.SecretString) {
            console.error('SecretString not found in Secrets Manager response.');
            throw new Error('Failed to retrieve valid secret from Secrets Manager.');
        }
        const sharedSecretData = JSON.parse(secretValueOutput.SecretString);
        const sharedSecret = sharedSecretData.secret;
        if (!sharedSecret) {
            console.error("'secret' key not found in shared secret JSON from Secrets Manager.");
            throw new Error('Invalid secret format from Secrets Manager.');
        }
        console.info('Successfully fetched shared secret.');

        // 2. Get EC2 Instance PrivateDnsName
        console.info(`Fetching instance details for EC2 instance: ${instanceId}`);
        const describeInstancesCommand = new DescribeInstancesCommand({ InstanceIds: [instanceId] });
        const ec2Output = await ec2Client.send(describeInstancesCommand);

        const reservations = ec2Output.Reservations;
        if (!reservations || reservations.length === 0 || !reservations[0].Instances || reservations[0].Instances.length === 0) {
            console.error(`Could not find instance details for ${instanceId}`);
            throw new Error(`Instance details not found for ${instanceId}.`);
        }
        const privateDnsName = reservations[0].Instances[0].PrivateDnsName;
        if (!privateDnsName) {
            console.error(`PrivateDnsName not found for ${instanceId}.`);
            throw new Error(`PrivateDnsName not found for ${instanceId}.`);
        }
        // This is the URL format Scalelite usually stores for a BBB server registered via its hostname
        // It's formed from the output of `bbb-conf --salt` (which is http://<hostname>/bigbluebutton/)
        // and Scalelite typically polls `/api` on that, so the registered URL is often this:
        const bbbServerApiUrl = `http://${privateDnsName}/bigbluebutton/api`;
        console.info(`Constructed BBB server API URL for matching in Scalelite: ${bbbServerApiUrl}`);


        // 3. Call Scalelite `getServers` API to find the internal Scalelite ID
        // Note: As of the current understanding, Scalelite's getServers API does not support
        // filtering by specific serverId or URL directly in the API call.
        // Therefore, all servers are fetched and filtered client-side.
        // If server-side filtering becomes available, this should be updated for efficiency.
        console.info(`Calling Scalelite getServers API to find internal ID for server URL: ${bbbServerApiUrl}`);
        const getServersQueryString = getSortedQueryString({}); // No specific query params for getServers other than checksum
        const getServersChecksum = calculateChecksum(GET_SERVERS_ACTION, getServersQueryString, "", sharedSecret);
        const getServersUrl = `${SCALELITE_API_BASE_URL}/${GET_SERVERS_ACTION}?${getServersQueryString ? getServersQueryString + '&' : ''}checksum=${getServersChecksum}`;
        
        console.info(`Calling getServers URL: ${getServersUrl}`);
        const getServersResponse = await httpClient.get<{ status: string, servers?: ScaleliteServer[] }>(getServersUrl);
        console.info(`getServers response status: ${getServersResponse.status}, data: ${JSON.stringify(getServersResponse.data)}`);

        if (getServersResponse.status !== 200 || getServersResponse.data.status !== 'ok' || !getServersResponse.data.servers) {
            console.error(`getServers API call failed or returned unexpected data. Status: ${getServersResponse.status}, Body: ${JSON.stringify(getServersResponse.data)}`);
            throw new Error('Failed to fetch servers from Scalelite or unexpected response format.');
        }

        let scaleliteInternalServerId: string | null = null;
        for (const server of getServersResponse.data.servers) {
            if (server.url === bbbServerApiUrl) {
                scaleliteInternalServerId = server.id;
                console.info(`Found Scalelite internal server ID: ${scaleliteInternalServerId} for URL ${bbbServerApiUrl}`);
                break;
            }
        }

        if (!scaleliteInternalServerId) {
            console.warn(`Could not find server with URL ${bbbServerApiUrl} in Scalelite's getServers response. Assuming already deregistered or registration failed.`);
            lifecycleActionResult = 'CONTINUE'; // Allow ASG to proceed
        } else {
            // 4. Call Scalelite `deleteServer` API
            console.info(`Preparing to call deleteServer for Scalelite internal ID: ${scaleliteInternalServerId}`);
            const deletePayload = { id: scaleliteInternalServerId };
            const deleteBodyString = JSON.stringify(deletePayload);
            const deleteServerQueryString = getSortedQueryString({}); // No specific query params for deleteServer other than checksum
            
            const deleteChecksum = calculateChecksum(DELETE_SERVER_ACTION, deleteServerQueryString, deleteBodyString, sharedSecret);
            const deleteUrl = `${SCALELITE_API_BASE_URL}/${DELETE_SERVER_ACTION}?${deleteServerQueryString ? deleteServerQueryString + '&' : ''}checksum=${deleteChecksum}`;
            
            console.info(`Preparing to call deleteServer for Scalelite internal ID: ${scaleliteInternalServerId}`);
            const deletePayload = { id: scaleliteInternalServerId };
            const deleteBodyString = JSON.stringify(deletePayload);
            const deleteServerQueryString = getSortedQueryString({}); // No specific query params for deleteServer other than checksum
            
            const deleteChecksum = calculateChecksum(DELETE_SERVER_ACTION, deleteServerQueryString, deleteBodyString, sharedSecret);
            const deleteUrl = `${SCALELITE_API_BASE_URL}/${DELETE_SERVER_ACTION}?${deleteServerQueryString ? deleteServerQueryString + '&' : ''}checksum=${deleteChecksum}`;
            
            try {
                console.info(`Calling Scalelite deleteServer API URL: ${deleteUrl} with body: ${deleteBodyString}`);
                const deleteServerResponse = await httpClient.post(deleteUrl, deletePayload, {
                    headers: { 'Content-Type': 'application/json' }
                });
                console.info(`deleteServer response status: ${deleteServerResponse.status}, data: ${JSON.stringify(deleteServerResponse.data)}`);

                // Scalelite's JSON API for deleteServer typically returns { "status": "ok", "message": "ok" } on success
                if (deleteServerResponse.status === 200 && deleteServerResponse.data.status === 'ok') {
                    console.info(`Successfully deregistered Scalelite internal ID ${scaleliteInternalServerId} from Scalelite.`);
                    lifecycleActionResult = 'CONTINUE';
                } else if (deleteServerResponse.status === 200 && typeof deleteServerResponse.data === 'string' && deleteServerResponse.data.includes('<returncode>SUCCESS</returncode>')) {
                    // Fallback for older XML-like responses if Content-Type was not strictly application/json by Scalelite
                    console.info(`Successfully deregistered Scalelite internal ID ${scaleliteInternalServerId} from Scalelite (XML success).`);
                    lifecycleActionResult = 'CONTINUE';
                } else {
                    console.error(`Scalelite deleteServer API did not report success for ID ${scaleliteInternalServerId}. Status: ${deleteServerResponse.status}, Response: ${JSON.stringify(deleteServerResponse.data)}`);
                    // lifecycleActionResult remains 'ABANDON' by default
                }
            } catch (deleteError: any) {
                if (axios.isAxiosError(deleteError) && deleteError.response?.status === 404) {
                    console.warn(`Scalelite deleteServer API returned 404 for ID ${scaleliteInternalServerId}. Assuming server already deleted or never existed.`);
                    lifecycleActionResult = 'CONTINUE';
                } else {
                    // For other errors (e.g., network issues, 500 errors from Scalelite),
                    // let the main error handler catch it and ABANDON.
                    console.error(`Error during Scalelite deleteServer API call for ID ${scaleliteInternalServerId}: ${deleteError.message}`, deleteError.stack);
                    throw deleteError; // Re-throw to be caught by the main try-catch block
                }
            }
        }

    } catch (error: any) {
        console.error(`An error occurred during the deregistration process: ${error.message}`, error.stack);
        // lifecycleActionResult remains 'ABANDON' due to error
    } finally {
        console.info(`Completing lifecycle action with result: ${lifecycleActionResult}`);
        const completeLifecycleParams = {
            LifecycleHookName: lifecycleHookName,
            AutoScalingGroupName: autoScalingGroupName,
            LifecycleActionResult: lifecycleActionResult,
            InstanceId: instanceId,
        };
        try {
            const completeLifecycleCommand = new CompleteLifecycleActionCommand(completeLifecycleParams);
            await asClient.send(completeLifecycleCommand);
            console.info(`Successfully completed lifecycle action for instance ${instanceId} with result ${lifecycleActionResult}.`);
        } catch (completionError: any) {
            console.error(`Failed to complete lifecycle action for instance ${instanceId}: ${completionError.message}`, completionError.stack);
            // This is a critical failure; the instance might remain in Terminating:Wait or be terminated by ASG timeout
        }
    }
    console.info(`Lambda execution finished. Action result: ${lifecycleActionResult}`);
};

// For local testing (optional)
// (async () => {
//     if (process.env.LOCAL_TEST) {
//         const testEvent = {
//             Records: [{
//                 Sns: {
//                     Message: JSON.stringify({
//                         EC2InstanceId: "i-xxxxxxxxxxxxxxxxx", // Replace with a test instance ID
//                         LifecycleHookName: "TestHook",
//                         AutoScalingGroupName: "TestASG"
//                     })
//                 }
//             }]
//         };
//         // Mock environment variables for local testing
//         process.env.SCALELITE_API_BASE_URL = "YOUR_SCALELITE_API_URL"; // e.g. https://scalelite.example.com/scalelite/api
//         process.env.SHARED_SECRET_ARN = "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:your-secret-name-XXXXXX";
//         process.env.AWS_REGION = "your-region";
//         await handler(testEvent);
//     }
// })();
