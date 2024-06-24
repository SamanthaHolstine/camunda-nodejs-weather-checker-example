const { App } = require("@slack/bolt");
const { Camunda8 } = require("@camunda8/sdk");
const { WebClient } = require('@slack/web-api');
require('dotenv').config();

const path = require("path");
const { type } = require("os");

// A function to pause execution for a specified delay time 
//  This is used to delay the code in order to get information from elasicsearch
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

// Create a new Slack app instance
const app = new App({
    // Slack token from the Oauth & Permissions tab – generated after launching into your workspace
    token: process.env.SLACK_TOKEN,
    // Signing secret from the Basic Information Tab
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    // Token from the App-level Token
    appToken: process.env.SLACK_APP_TOKEN
});
const web = new WebClient(process.env.SLACK_TOKEN);

// Slack command handler for the /weather command
//  /weather [city]
app.command("/weather", async ({ command, ack, say }) => {
    try {
        // Acknowledge the command to prevent timeout and extract the city from the command text
        await ack();
        let city = command.text;
        let deploy;

        // Create a new Camunda 8 instance
        const camunda = new Camunda8();
        const zeebe = camunda.getZeebeGrpcApiClient();
        const operate = camunda.getOperateApiClient();

        //Deploy the process
        async function deployProcess() {
            deploy = await zeebe.deployResource({
                processFilename: path.join(process.cwd(), "weather-checker.bpmn"),
            });
            console.log(
                `[Zeebe] Deployed process ${deploy.deployments[0].process.bpmnProcessId}`
            );
        }

        // Main function to handle the weather command: start the process instance, return all variables from Operate
        async function main() {
            //Create a process instance with the deployed model above
            const p = await zeebe.createProcessInstanceWithResult({
                bpmnProcessId: `node-slackbot`,
                variables: {
                    city: city,
                },
            });
            console.log(`[Zeebe] Finished Process Instance ${p.processInstanceKey}.`);
            console.log(`[Zeebe] serviceTaskOutcome is ${p.variables.serviceTaskOutcome}`);

            // Operate -- get status of process to make sure it completed correctly
            try {
                // Delay for 8 seconds to get information from elasicsearch
                await sleep(10000);
                const historicalProcessInstance = await operate.getProcessInstance(p.processInstanceKey);
                console.log("[Operate] state", historicalProcessInstance.state);
                // Print out variables for completed process
                if (historicalProcessInstance.state == 'COMPLETED') {
                    const variables = await operate.getJSONVariablesforProcess(historicalProcessInstance.key);
                    console.log('\n[Operate] Variables:', JSON.stringify(variables, null, 2));
                }
            } catch (e) {
                console.log(JSON.stringify(e, null, 2));
                console.log(`[Operate] error ${e.response.body.message}`);
                return null;
            }
        }

        //Zeebe service task -- Outputting weather to slack
        console.log("Starting worker...");
        zeebe.createWorker({
            taskType: "service-task",
            taskHandler: (job) => {
                console.log(`[Zeebe Worker] handling job of type ${job.type}`);

                const { temperature: temp, feels_like: feelsLike, city: city } = job.variables;

                if (job.variables.city == null || job.variables.city == '') {
                    say(city + " is not a valid city")
                } else {
                    say("The temperature in " + city + " is currently " + temp + " degrees. It feels like " + feelsLike + " degrees outside.");
                }
                return job.complete({
                    serviceTaskOutcome: "Weather returned!",
                });
            },
        });

        // Deploy the process and start the main function
        deployProcess();
        main();
    }
    catch (error) {
        console.log("err")
        console.error(error);
    }
});

// Slack command handler for the /export command
//  /export [dashboard or report] [id]
app.command("/export", async ({ command, ack, say }) => {
    try {
        // Acknowledge the command to prevent timeout and split up the command
        //  into respective variables
        await ack();
        let exportCommand = command.text.split(" ");
        const exportType = exportCommand[0];
        const id = exportCommand[1];

        const fs = require("node:fs");

        // Create a new Camunda 8 instance
        const camunda = new Camunda8();
        const optimize = camunda.getOptimizeApiClient();

        // Main function to handle the export command
        async function main() {
            // Optimize -- share the dashboard info with updated vars from new weather query
            try {
                // Check readiness of Optimize and enable sharing of dashboards
                const ready = await optimize.getReadiness();
                console.log('[Optimize] Ready!', ready);

                await optimize.enableSharing();
                console.log("[Optimize] Sharing enabled");

                // Exporting Optimize dashboard or report with provided id
                let exportDefs;
                if (exportType == "dashboard") {
                    // "35b34fb3-ecf6-40ed-98cc-02c37afff40f"
                    exportDefs = await optimize.exportDashboardDefinitions([id]);
                } else if (exportType == "report") {
                    //"fdf3f09f-314a-4f04-99ee-882de2990200"
                    exportDefs = await optimize.exportReportDefinitions([id]);
                }

                // Send exported dashboard or report as a file to Slack
                await sleep(10000);
                await say("Here is your updated Optimize " + exportType + " to upload:");
                const fileBuffer = Buffer.from(JSON.stringify(exportDefs, null, 2), 'utf-8');
                await web.files.upload({
                channels: command.channel_id,
                filename: "optimize_dashboard.json",
                filetype: "json",
                title: "Optimize Dashboard",
                file: fileBuffer,
                });
                console.log("[Optimize] " + exportType + " exported");

            } catch (e) {
                console.log('[Optimize] Error : ' + e);
            }

        // Start the main function
        }
        main();
    }
    catch (error) {
        console.log("err")
        console.error(error);
    }
});

// Slack command handler for the /label command
//  /label [variable] [variableType] [label]
app.command("/label", async ({ command, ack, say }) => {
    try {
        // Acknowledge the command to prevent timeout and split up the command
        //  into respective variables        
        await ack();
        let labelCommand = command.text.split(" ");
        const variable = labelCommand[0];
        const variableType = labelCommand[1];
        let label = labelCommand[2];
        // If the label for the variable is more than one word, concatenate
        //  label into one variable
        if (labelCommand.length > 3) {
            label += " ";
            for (let i = 3; i < labelCommand.length; i++) {
                console.log(labelCommand[i]);
                label += labelCommand[i] + " ";
            }
            console.log(typeof(label));
        }

        // Create a new Camunda 8 instance
        const camunda = new Camunda8();
        const optimize = camunda.getOptimizeApiClient();

        // Main function to handle the label command
        async function main() {
            try {
                // Optimize -- label the variable with the provided label
                const ready = await optimize.getReadiness();
                console.log('[Optimize] Ready!', ready);
                const variableLabels = {
                    "definitionKey": "node-slackbot-demo",
                    "labels": [
                        {
                            "variableName" : variable,
                            "variableType" : variableType,
                            "variableLabel": label
                        }
                    ]
                };
                await optimize.labelVariables(variableLabels);
            } catch (e) {
                console.log('[Optimize] Error : ' + e);
            }
        }
        main();
    }
    catch (error) {
        console.log("err")
        console.error(error);
    }
});

app.start(3000);            