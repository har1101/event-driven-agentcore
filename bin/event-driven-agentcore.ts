#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventDrivenAgentcoreStack } from '../lib/event-driven-agentcore-stack';

const app = new cdk.App();
new EventDrivenAgentcoreStack(app, 'EventDrivenAgentcoreStack', {
  // Use the current CLI configuration for Account and Region
  // This is required for Cognito domain prefix (which uses account ID)
  // and EventBridge API Destination endpoint construction
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});