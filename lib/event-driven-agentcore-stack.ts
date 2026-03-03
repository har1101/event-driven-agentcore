import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from 'deploy-time-build';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';

export class EventDrivenAgentcoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;

    // ===========================================
    // Cognito User Pool (M2M認証用)
    // ===========================================
    const userPool = new cognito.UserPool(this, 'AgentCoreUserPool', {
      userPoolName: 'agentcore-user-pool',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Resource Server (OAuth スコープ定義)
    const resourceServer = userPool.addResourceServer('AgentCoreResourceServer', {
      identifier: 'agentcore',
      scopes: [
        { scopeName: 'invoke', scopeDescription: 'Invoke AgentCore Runtime' },
      ],
    });

    // App Client (Client Credentials Grant 用)
    const appClient = userPool.addClient('AgentCoreM2MClient', {
      userPoolClientName: 'agentcore-m2m-client',
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [
          cognito.OAuthScope.custom('agentcore/invoke'),
        ],
      },
    });

    // Resource Server に依存関係を追加（スコープが先に作成される必要あり）
    appClient.node.addDependency(resourceServer);

    // Cognito Domain (OAuth Token Endpoint に必要)
    const cognitoDomain = userPool.addDomain('AgentCoreDomain', {
      cognitoDomain: {
        domainPrefix: `agentcore-${cdk.Stack.of(this).account}`,
      },
    });

    // ===========================================
    // Custom Resource: Cognito Client Secret 取得
    // ===========================================
    // DescribeUserPoolClient API を呼び出して Client Secret を取得
    const describeUserPoolClient = new cr.AwsCustomResource(this, 'DescribeCognitoClient', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'describeUserPoolClient',
        parameters: {
          UserPoolId: userPool.userPoolId,
          ClientId: appClient.userPoolClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of(appClient.userPoolClientId),
      },
      onUpdate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'describeUserPoolClient',
        parameters: {
          UserPoolId: userPool.userPoolId,
          ClientId: appClient.userPoolClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of(appClient.userPoolClientId),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:DescribeUserPoolClient'],
          resources: [userPool.userPoolArn],
        }),
      ]),
    });

    // Client Secret を取得（トークンとして参照）
    const cognitoClientSecret = describeUserPoolClient.getResponseField('UserPoolClient.ClientSecret');

    // ===========================================
    // SNS Topic (Agent通知用)
    // ===========================================
    const notificationTopic = new sns.Topic(this, 'AgentNotificationTopic', {
      topicName: 'agentcore-notification-topic',
      displayName: 'AgentCore Agent Notification',
    });

    // ===========================================
    // AgentCore Memory
    // ===========================================
    const memoryStrategyName = 'summary_strategy';

    const memory = new agentcore.Memory(this, 'AgentCoreMemory', {
      memoryName: 'event_driven_agent_memory',
      description: 'Event-driven agent memory for interaction history',
      expirationDuration: cdk.Duration.days(90),
      memoryStrategies: [
        agentcore.MemoryStrategy.usingSummarization({
          name: memoryStrategyName,
          namespaces: [`/strategies/${memoryStrategyName}/actors/{actorId}/sessions/{sessionId}`],
        }),
      ],
    });

    // ===========================================
    // AgentCore Runtime (JWT認証付き)
    // ===========================================
    // Container Image Build (deploy-time-build)
    const agentcoreRuntimeImage = new ContainerImageBuild(this, 'AgentImage', {
      directory: './agent',
      platform: Platform.LINUX_ARM64,
    });

    // AgentCore Runtime with JWT Authorizer
    const runtime = new agentcore.Runtime(this, 'EventDrivenAgentCoreRuntime', {
      runtimeName: 'event_driven_agent',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
        agentcoreRuntimeImage.repository,
        agentcoreRuntimeImage.imageTag
      ),
      description: 'Event-driven Strands Agent with JWT authentication',
      // JWT認証設定
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
        userPool,
        [appClient]
      ),
      // 環境変数
      environmentVariables: {
        AGENTCORE_MEMORY_ID: memory.memoryId,
        AGENTCORE_MEMORY_STRATEGY_ID: memoryStrategyName,
        SNS_TOPIC_ARN: notificationTopic.topicArn,
      },
    });

    // SNS Publish 権限を Runtime に付与
    notificationTopic.grantPublish(runtime.role);

    // Bedrock Model 権限
    runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        // 基盤モデル（東京・大阪）
        'arn:aws:bedrock:ap-northeast-1::foundation-model/*',
        'arn:aws:bedrock:ap-northeast-3::foundation-model/*',
        // Inference Profile（東京・大阪）
        `arn:aws:bedrock:ap-northeast-1:${this.account}:inference-profile/*`,
        `arn:aws:bedrock:ap-northeast-3:${this.account}:inference-profile/*`,
      ],
    }));

    // AgentCore Memory 権限（L2 construct の grant メソッドで付与）
    memory.grantFullAccess(runtime.role);

    // ===========================================
    // EventBridge Connection (OAuth Client Credentials)
    // ===========================================
    // Cognito OAuth Token Endpoint
    const cognitoTokenEndpoint = `https://${cognitoDomain.domainName}.auth.${region}.amazoncognito.com/oauth2/token`;

    // EventBridge Connection with OAuth
    const connection = new events.Connection(this, 'AgentCoreConnection', {
      connectionName: 'agentcore-oauth-connection',
      description: 'OAuth connection for AgentCore Runtime invocation',
      authorization: events.Authorization.oauth({
        authorizationEndpoint: cognitoTokenEndpoint,
        httpMethod: events.HttpMethod.POST,
        clientId: appClient.userPoolClientId,
        clientSecret: cdk.SecretValue.unsafePlainText(cognitoClientSecret),  // Custom Resource から取得
        bodyParameters: {
          'grant_type': events.HttpParameter.fromString('client_credentials'),
          'scope': events.HttpParameter.fromString('agentcore/invoke'),
        },
      }),
    });

    // ===========================================
    // API Destination (Runtime ID + accountId 方式)
    // ===========================================
    // AgentCore Runtime エンドポイント形式:
    // https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{runtime_id}/invocations?accountId={account}
    //
    // 重要: EventBridge API Destination の URL エンコーディング問題の解決策
    // - ARN 全体をパスに含めると `/` のエンコーディング問題が発生
    // - 代わりに Runtime ID のみを `*` ワイルドカードで渡す
    // - accountId はクエリパラメータで渡す
    // - これにより URL 内の `/` 問題を完全に回避
    //
    // 参考: https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_HttpParameters.html
    const apiDestination = new events.ApiDestination(this, 'AgentCoreApiDestination', {
      // 名前は CloudFormation に自動生成させる（手動変更との競合を避けるため）
      description: 'API Destination for AgentCore Runtime async invocation',
      connection: connection,
      // `*` ワイルドカードを使用 - Runtime ID のみが埋め込まれる
      endpoint: `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/*/invocations`,
      httpMethod: events.HttpMethod.POST,
      rateLimitPerSecond: 10,
    });

    // ===========================================
    // EventBridge Logging (デバッグ用)
    // ===========================================
    const eventLogGroup = new logs.LogGroup(this, 'EventBridgeLogGroup', {
      logGroupName: '/aws/events/agentcore-invocation',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ===========================================
    // Dead Letter Queue (失敗時のデバッグ用)
    // ===========================================
    const dlq = new sqs.Queue(this, 'EventBridgeDLQ', {
      queueName: 'agentcore-eventbridge-dlq',
      retentionPeriod: cdk.Duration.days(7),
    });

    // ===========================================
    // EventBridge Rule (イベント駆動)
    // ===========================================
    const rule = new events.Rule(this, 'AgentCoreInvocationRule', {
      ruleName: 'agentcore-invocation-rule',
      description: 'Triggers AgentCore Runtime on matching events',
      eventPattern: {
        source: ['custom.agentcore'],
        detailType: ['AgentInvocation'],
        detail: {
          action: ['start'],
        },
      },
    });

    // Target 1: CloudWatch Logs (デバッグ用 - 全イベントをログ出力)
    rule.addTarget(new targets.CloudWatchLogGroup(eventLogGroup));

    // Target 2: API Destination (AgentCore Runtime 呼び出し)
    // Runtime ID + accountId 方式で URL エンコーディング問題を回避
    rule.addTarget(new targets.ApiDestination(apiDestination, {
      // Runtime ID のみを PathParameterValues として渡す（`*` ワイルドカードに埋め込まれる）
      // ARN 全体ではなく ID のみを使うことで、URL 内の `/` 問題を回避
      pathParameterValues: [runtime.agentRuntimeId],
      // accountId をクエリパラメータとして渡す
      queryStringParameters: {
        accountId: this.account,
      },
      event: events.RuleTargetInput.fromObject({
        action: events.EventField.fromPath('$.detail.action'),
        job_id: events.EventField.fromPath('$.detail.job_id'),
        input: events.EventField.fromPath('$.detail.input'),
        seconds: events.EventField.fromPath('$.detail.seconds'),
      }),
      headerParameters: {
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': events.EventField.fromPath('$.detail.session_id'),
      },
      retryAttempts: 3,
      deadLetterQueue: dlq,  // 失敗したイベントをDLQに送信
    }));

    // ===========================================
    // Stack Outputs
    // ===========================================
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: appClient.userPoolClientId,
      description: 'Cognito App Client ID (M2M)',
    });
    new cdk.CfnOutput(this, 'CognitoDomainUrl', {
      value: `https://${cognitoDomain.domainName}.auth.${region}.amazoncognito.com`,
      description: 'Cognito Domain URL for OAuth',
    });
    new cdk.CfnOutput(this, 'MemoryId', {
      value: memory.memoryId,
      description: 'AgentCore Memory ID',
    });
    new cdk.CfnOutput(this, 'MemoryArn', {
      value: memory.memoryArn,
      description: 'AgentCore Memory ARN',
    });
    new cdk.CfnOutput(this, 'RuntimeArn', {
      value: runtime.agentRuntimeArn,
      description: 'AgentCore Runtime ARN',
    });
    new cdk.CfnOutput(this, 'ConnectionArn', {
      value: connection.connectionArn,
      description: 'EventBridge Connection ARN',
    });
    new cdk.CfnOutput(this, 'ApiDestinationArn', {
      value: apiDestination.apiDestinationArn,
      description: 'EventBridge API Destination ARN',
    });
    new cdk.CfnOutput(this, 'RuleArn', {
      value: rule.ruleArn,
      description: 'EventBridge Rule ARN',
    });
    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: notificationTopic.topicArn,
      description: 'SNS Topic ARN for Agent notifications',
    });
    new cdk.CfnOutput(this, 'EventBridgeLogGroupName', {
      value: eventLogGroup.logGroupName,
      description: 'CloudWatch Log Group for EventBridge debugging',
    });
    new cdk.CfnOutput(this, 'DLQUrl', {
      value: dlq.queueUrl,
      description: 'Dead Letter Queue URL for failed invocations',
    });
  }
}
