'use strict';

/**
 * Temporary live AWS Bedrock invocation script.
 *
 * Sends a minimal "Hello" message to the configured Bedrock model using the AWS SDK.
 *
 * Env vars (expected to already be present in .env):
 * - AWS_ACCESS_KEY_ID
 * - AWS_SECRET_ACCESS_KEY
 * - AWS_REGION (optional; default us-east-2)
 *
 * Usage:
 *   node scripts/test-bedrock.js
 *
 * Exit codes:
 *   0 = success
 *   2 = missing AWS creds
 *   1 = failure
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const MODEL_ID =
  'arn:aws:bedrock:us-east-2:461029538476:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

function nowMs() {
  return Date.now();
}

function hasCreds() {
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

async function main() {
  if (!hasCreds()) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: 'MISSING_AWS_CREDS',
          message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in .env to run this test.'
        },
        null,
        2
      )
    );
    process.exitCode = 2;
    return;
  }

  const region = process.env.AWS_REGION || 'us-east-2';

  const client = new BedrockRuntimeClient({ region });

  // For Anthropic models via Bedrock Runtime, the payload is typically:
  // { anthropic_version, max_tokens, messages: [{ role, content: [{ type, text }] }] }
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }]
      }
    ]
  };

  const start = nowMs();
  try {
    const cmd = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(JSON.stringify(payload))
    });

    const resp = await client.send(cmd);
    const latencyMs = nowMs() - start;

    const raw = resp?.body ? Buffer.from(resp.body).toString('utf8') : null;

    console.log(
      JSON.stringify(
        {
          ok: true,
          region,
          modelId: MODEL_ID,
          latencyMs,
          httpStatusCode: resp?.$metadata?.httpStatusCode ?? null,
          responseBody: raw
        },
        null,
        2
      )
    );
    process.exitCode = 0;
  } catch (err) {
    const latencyMs = nowMs() - start;

    console.error(
      JSON.stringify(
        {
          ok: false,
          region,
          modelId: MODEL_ID,
          latencyMs,
          error: err?.name || err?.code || 'BEDROCK_ERROR',
          message: err?.message || String(err),
          // $metadata is common on AWS SDK errors
          httpStatusCode: err?.$metadata?.httpStatusCode ?? null
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: 'UNHANDLED', message: e?.message || String(e) }, null, 2));
  process.exitCode = 1;
});
