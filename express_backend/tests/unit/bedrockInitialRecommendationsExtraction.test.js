'use strict';

const bedrockService = require('../../src/services/bedrockService');

describe('bedrock initial recommendations extraction (unit)', () => {
  test('extracts top-level array of role objects (not nested key_responsibilities array) and validates schema', async () => {
    // This mirrors the authoritative failing response pattern: a top-level array of role objects,
    // each containing nested arrays like key_responsibilities.
    const rawText = [
      '```json',
      '[',
      '  {',
      '    "title": "Full Stack Developer",',
      '    "industry": "Technology/Software Development",',
      '    "salary_lpa_range": "₹8–₹18 LPA",',
      '    "experience_range": "2–5 years",',
      '    "description": "Design and develop end-to-end web applications. Collaborate with cross-functional teams to deliver features.",',
      '    "key_responsibilities": [',
      '      "Build and maintain full-stack web applications using React/Angular/Vue.js with Node.js/Python/Java backends",',
      '      "Design database schemas, write optimized queries, and implement backend business logic for scalable systems",',
      '      "Develop responsive interfaces and integrate third-party APIs while ensuring code quality through testing"',
      '    ],',
      '    "required_skills": [',
      '      "Full-stack web development",',
      '      "Database design and backend logic",',
      '      "Responsive interface design",',
      '      "RESTful API development",',
      '      "JavaScript/TypeScript"',
      '    ]',
      '  },',
      '  {',
      '    "title": "Machine Learning Engineer",',
      '    "industry": "AI/ML/Data Science",',
      '    "salary_lpa_range": "₹12–₹25 LPA",',
      '    "experience_range": "2–5 years",',
      '    "description": "Develop and deploy machine learning models. Iterate based on business requirements.",',
      '    "key_responsibilities": [',
      '      "Build predictive models using scikit-learn, TensorFlow, or PyTorch",',
      '      "Implement feature engineering pipelines for model training",',
      '      "Deploy models with monitoring and performance optimization"',
      '    ],',
      '    "required_skills": [',
      '      "Python",',
      '      "Machine Learning",',
      '      "Model Deployment",',
      '      "Feature Engineering",',
      '      "Data Analysis"',
      '    ]',
      '  },',
      '  {',
      '    "title": "AI/ML Product Engineer",',
      '    "industry": "Product Development/SaaS",',
      '    "salary_lpa_range": "₹15–₹30 LPA",',
      '    "experience_range": "3–6 years",',
      '    "description": "Build AI-powered features into applications. Ensure models are production-ready.",',
      '    "key_responsibilities": [',
      '      "Prototype ML-backed product features and validate with user feedback",',
      '      "Integrate ML models into full-stack apps with robust APIs",',
      '      "Translate requirements into scalable ML solutions"',
      '    ],',
      '    "required_skills": [',
      '      "Product Thinking",',
      '      "Full-stack Development",',
      '      "Machine Learning",',
      '      "API Design",',
      '      "Experimentation"',
      '    ]',
      '  },',
      '  {',
      '    "title": "Computer Vision Engineer",',
      '    "industry": "AI/Computer Vision/Imaging",',
      '    "salary_lpa_range": "₹10–₹22 LPA",',
      '    "experience_range": "2–5 years",',
      '    "description": "Develop computer vision solutions. Optimize for real-time performance.",',
      '    "key_responsibilities": [',
      '      "Build image processing pipelines using OpenCV",',
      '      "Train deep learning models for detection/segmentation",',
      '      "Optimize inference for latency and throughput"',
      '    ],',
      '    "required_skills": [',
      '      "OpenCV",',
      '      "Deep Learning",',
      '      "Python",',
      '      "Model Optimization",',
      '      "Computer Vision"',
      '    ]',
      '  },',
      '  {',
      '    "title": "Data Engineer",',
      '    "industry": "Data Platforms",',
      '    "salary_lpa_range": "₹12–₹26 LPA",',
      '    "experience_range": "3–6 years",',
      '    "description": "Build reliable data pipelines. Enable analytics and ML workloads.",',
      '    "key_responsibilities": [',
      '      "Design and build batch/streaming pipelines",',
      '      "Model data for analytics and downstream consumption",',
      '      "Improve reliability with monitoring and quality checks"',
      '    ],',
      '    "required_skills": [',
      '      "SQL",',
      '      "ETL",',
      '      "Data Modeling",',
      '      "Python",',
      '      "Cloud Data Services"',
      '    ]',
      '  }',
      ']',
      '```'
    ].join('\n');

    // Mock Bedrock client + invoke result so we test ONLY parsing/extraction/validation logic.
    const originalEnv = process.env.BEDROCK_DEBUG_RAW_OUTPUT;
    process.env.BEDROCK_DEBUG_RAW_OUTPUT = 'true';

    const mockSend = jest.fn(async () => {
      const bedrockJson = { content: [{ type: 'text', text: rawText }] };
      return { body: Buffer.from(JSON.stringify(bedrockJson), 'utf-8') };
    });

    // Monkey-patch the BedrockRuntimeClient constructor used inside bedrockService by temporarily
    // overriding require cache for @aws-sdk/client-bedrock-runtime.
    jest.resetModules();
    jest.doMock('@aws-sdk/client-bedrock-runtime', () => {
      return {
        BedrockRuntimeClient: function BedrockRuntimeClient() {
          return { send: mockSend };
        },
        InvokeModelCommand: function InvokeModelCommand(_) {
          return {};
        }
      };
    });

    // Re-require after mocking
    // eslint-disable-next-line global-require
    const svc = require('../../src/services/bedrockService');

    const finalPersona = { skills_with_proficiency: [{ name: 'Python', proficiency: 80 }] };

    const result = await svc.getInitialRecommendations(finalPersona, {
      // Avoid needing AWS_REGION in unit tests; _getBedrockClient isn't actually used because we mocked it.
      allowFallback: false
    });

    expect(result).toBeTruthy();
    expect(result.usedFallback).toBe(false);
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

    // Ensure role objects were extracted/validated, not a nested string array.
    for (const r of result.roles) {
      expect(typeof r).toBe('object');
      expect(typeof r.role_title).toBe('string');
      expect(r.role_title.length).toBeGreaterThan(0);
      expect(typeof r.industry).toBe('string');
      expect(typeof r.salary_lpa_range).toBe('string');
      expect(Array.isArray(r.key_responsibilities)).toBe(true);
      expect(Array.isArray(r.required_skills)).toBe(true);
    }

    process.env.BEDROCK_DEBUG_RAW_OUTPUT = originalEnv;
    jest.dontMock('@aws-sdk/client-bedrock-runtime');
  });

  test('salvages truncated top-level array (prefers role objects over nested key_responsibilities string[])', async () => {
    /**
     * Authoritative failure mode:
     * - Output begins with a top-level array of role objects
     * - Output is truncated mid-object (so the top-level JSON is invalid)
     * - Nested arrays like key_responsibilities are still balanced/valid substrings
     *
     * Expected behavior:
     * - Extractor salvages the *top-level* array by keeping fully-closed objects only
     * - Validation succeeds and returns exactly 5 roles
     */
    const rawTextTruncated = [
      '```json',
      '[',
      '  {',
      '    \"title\": \"Full Stack Developer\",',
      '    \"industry\": \"Technology/Software Services\",',
      '    \"salary_lpa_range\": \"₹8–₹18 LPA\",',
      '    \"experience_range\": \"2–5 years\",',
      '    \"description\": \"Design and develop end-to-end web applications using modern frontend frameworks and backend technologies. Collaborate with cross-functional teams to deliver scalable, responsive solutions.\",',
      '    \"key_responsibilities\": [',
      '      \"Build responsive web interfaces using React/Angular/Vue.js with focus on user experience and accessibility\",',
      '      \"Develop and maintain RESTful APIs using Node.js/Python/Java with proper authentication and error handling\",',
      '      \"Design and optimize relational and NoSQL database schemas for high-performance data operations\"',
      '    ],',
      '    \"required_skills\": [\"JavaScript\",\"React\",\"Node.js\",\"REST APIs\",\"SQL\"]',
      '  },',
      '  {',
      '    \"title\": \"Machine Learning Engineer\",',
      '    \"industry\": \"AI/ML/Data Science\",',
      '    \"salary_lpa_range\": \"₹12–₹25 LPA\",',
      '    \"experience_range\": \"2–5 years\",',
      '    \"description\": \"Develop, train, and deploy machine learning models for business problems. Optimize models via feature engineering and tuning.\",',
      '    \"key_responsibilities\": [\"Build ML pipelines\",\"Train models\",\"Deploy with monitoring\"],',
      '    \"required_skills\": [\"Python\",\"TensorFlow\",\"PyTorch\",\"MLOps\",\"Data Prep\"]',
      '  },',
      '  {',
      '    \"title\": \"AI/ML Product Engineer\",',
      '    \"industry\": \"Product-based Tech Companies\",',
      '    \"salary_lpa_range\": \"₹15–₹30 LPA\",',
      '    \"experience_range\": \"3–6 years\",',
      '    \"description\": \"Integrate AI models into user-facing product features. Iterate quickly with product and design stakeholders.\",',
      '    \"key_responsibilities\": [\"Integrate LLM APIs\",\"Prototype features\",\"Optimize pipelines\"],',
      '    \"required_skills\": [\"API Integration\",\"Prompting\",\"Python\",\"JavaScript\",\"Cloud\"]',
      '  },',
      '  {',
      '    \"title\": \"Computer Vision Engineer\",',
      '    \"industry\": \"AI/Automation/Robotics\",',
      '    \"salary_lpa_range\": \"₹10–₹22 LPA\",',
      '    \"experience_range\": \"2–5 years\",',
      '    \"description\": \"Develop computer vision algorithms for image/video analysis. Optimize models for inference speed.\",',
      '    \"key_responsibilities\": [\"Train detection models\",\"Build preprocessing\",\"Optimize inference\"],',
      '    \"required_skills\": [\"OpenCV\",\"PyTorch\",\"CNNs\",\"Optimization\",\"Python\"]',
      '  },',
      '  {',
      '    \"title\": \"Data Engineer\",',
      '    \"industry\": \"Data Platforms\",',
      '    \"salary_lpa_range\": \"₹12–₹26 LPA\",',
      '    \"experience_range\": \"3–6 years\",',
      '    \"description\": \"Build reliable batch and streaming pipelines. Model data for analytics consumers.\",',
      '    \"key_responsibilities\": [\"Build pipelines\",\"Model data\",\"Monitoring\"],',
      '    \"required_skills\": [\"SQL\",\"ETL\",\"Python\",\"Data Modeling\",\"Cloud\"]',
      '  },',
      '  {',
      '    \"title\": \"Truncated Role\",',
      '    \"industry\": \"Broken',
      '```'
    ].join('\n');

    const originalEnv = process.env.BEDROCK_DEBUG_RAW_OUTPUT;
    process.env.BEDROCK_DEBUG_RAW_OUTPUT = 'true';

    const mockSend = jest.fn(async () => {
      const bedrockJson = { content: [{ type: 'text', text: rawTextTruncated }] };
      return { body: Buffer.from(JSON.stringify(bedrockJson), 'utf-8') };
    });

    jest.resetModules();
    jest.doMock('@aws-sdk/client-bedrock-runtime', () => {
      return {
        BedrockRuntimeClient: function BedrockRuntimeClient() {
          return { send: mockSend };
        },
        InvokeModelCommand: function InvokeModelCommand(_) {
          return {};
        }
      };
    });

    // eslint-disable-next-line global-require
    const svc = require('../../src/services/bedrockService');

    const finalPersona = { skills_with_proficiency: [{ name: 'Python', proficiency: 80 }] };

    const result = await svc.getInitialRecommendations(finalPersona, { allowFallback: false });

    expect(result).toBeTruthy();
    expect(result.usedFallback).toBe(false);
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

    // Ensure we got role objects (not nested key_responsibilities strings).
    for (const r of result.roles) {
      expect(r && typeof r === 'object').toBe(true);
      expect(typeof r.role_title).toBe('string');
      expect(r.role_title.length).toBeGreaterThan(0);
      expect(Array.isArray(r.key_responsibilities)).toBe(true);
    }

    process.env.BEDROCK_DEBUG_RAW_OUTPUT = originalEnv;
    jest.dontMock('@aws-sdk/client-bedrock-runtime');
  });

  test('salvages truncated top-level array (prefers role objects over nested key_responsibilities string[])', async () => {
    /**
     * Authoritative failure mode:
     * - Output begins with a top-level array of role objects
     * - Output is truncated mid-object (so the top-level JSON is invalid)
     * - Nested arrays like key_responsibilities are still balanced/valid substrings
     *
     * Expected behavior:
     * - Extractor salvages the *top-level* array by keeping fully-closed objects only
     * - Validation succeeds and returns exactly 5 roles
     */
    const rawTextTruncated = [
      '```json',
      '[',
      '  {',
      '    \"title\": \"Full Stack Developer\",',
      '    \"industry\": \"Technology/Software Services\",',
      '    \"salary_lpa_range\": \"₹8–₹18 LPA\",',
      '    \"experience_range\": \"2–5 years\",',
      '    \"description\": \"Design and develop end-to-end web applications using modern frontend frameworks and backend technologies. Collaborate with cross-functional teams to deliver scalable, responsive solutions.\",',
      '    \"key_responsibilities\": [',
      '      \"Build responsive web interfaces using React/Angular/Vue.js with focus on user experience and accessibility\",',
      '      \"Develop and maintain RESTful APIs using Node.js/Python/Java with proper authentication and error handling\",',
      '      \"Design and optimize relational and NoSQL database schemas for high-performance data operations\"',
      '    ],',
      '    \"required_skills\": [\"JavaScript\",\"React\",\"Node.js\",\"REST APIs\",\"SQL\"]',
      '  },',
      '  {',
      '    \"title\": \"Machine Learning Engineer\",',
      '    \"industry\": \"AI/ML/Data Science\",',
      '    \"salary_lpa_range\": \"₹12–₹25 LPA\",',
      '    \"experience_range\": \"2–5 years\",',
      '    \"description\": \"Develop, train, and deploy machine learning models for business problems. Optimize models via feature engineering and tuning.\",',
      '    \"key_responsibilities\": [\"Build ML pipelines\",\"Train models\",\"Deploy with monitoring\"],',
      '    \"required_skills\": [\"Python\",\"TensorFlow\",\"PyTorch\",\"MLOps\",\"Data Prep\"]',
      '  },',
      '  {',
      '    \"title\": \"AI/ML Product Engineer\",',
      '    \"industry\": \"Product-based Tech Companies\",',
      '    \"salary_lpa_range\": \"₹15–₹30 LPA\",',
      '    \"experience_range\": \"3–6 years\",',
      '    \"description\": \"Integrate AI models into user-facing product features. Iterate quickly with product and design stakeholders.\",',
      '    \"key_responsibilities\": [\"Integrate LLM APIs\",\"Prototype features\",\"Optimize pipelines\"],',
      '    \"required_skills\": [\"API Integration\",\"Prompting\",\"Python\",\"JavaScript\",\"Cloud\"]',
      '  },',
      '  {',
      '    \"title\": \"Computer Vision Engineer\",',
      '    \"industry\": \"AI/Automation/Robotics\",',
      '    \"salary_lpa_range\": \"₹10–₹22 LPA\",',
      '    \"experience_range\": \"2–5 years\",',
      '    \"description\": \"Develop computer vision algorithms for image/video analysis. Optimize models for inference speed.\",',
      '    \"key_responsibilities\": [\"Train detection models\",\"Build preprocessing\",\"Optimize inference\"],',
      '    \"required_skills\": [\"OpenCV\",\"PyTorch\",\"CNNs\",\"Optimization\",\"Python\"]',
      '  },',
      '  {',
      '    \"title\": \"Data Engineer\",',
      '    \"industry\": \"Data Platforms\",',
      '    \"salary_lpa_range\": \"₹12–₹26 LPA\",',
      '    \"experience_range\": \"3–6 years\",',
      '    \"description\": \"Build reliable batch and streaming pipelines. Model data for analytics consumers.\",',
      '    \"key_responsibilities\": [\"Build pipelines\",\"Model data\",\"Monitoring\"],',
      '    \"required_skills\": [\"SQL\",\"ETL\",\"Python\",\"Data Modeling\",\"Cloud\"]',
      '  },',
      '  {',
      '    \"title\": \"Truncated Role\",',
      '    \"industry\": \"Broken',
      '```'
    ].join('\\n');

    const originalEnv = process.env.BEDROCK_DEBUG_RAW_OUTPUT;
    process.env.BEDROCK_DEBUG_RAW_OUTPUT = 'true';

    const mockSend = jest.fn(async () => {
      const bedrockJson = { content: [{ type: 'text', text: rawTextTruncated }] };
      return { body: Buffer.from(JSON.stringify(bedrockJson), 'utf-8') };
    });

    jest.resetModules();
    jest.doMock('@aws-sdk/client-bedrock-runtime', () => {
      return {
        BedrockRuntimeClient: function BedrockRuntimeClient() {
          return { send: mockSend };
        },
        InvokeModelCommand: function InvokeModelCommand(_) {
          return {};
        }
      };
    });

    // eslint-disable-next-line global-require
    const svc = require('../../src/services/bedrockService');

    const finalPersona = { skills_with_proficiency: [{ name: 'Python', proficiency: 80 }] };

    const result = await svc.getInitialRecommendations(finalPersona, { allowFallback: false });

    expect(result).toBeTruthy();
    expect(result.usedFallback).toBe(false);
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

    // Ensure we got role objects (not nested key_responsibilities strings).
    for (const r of result.roles) {
      expect(r && typeof r === 'object').toBe(true);
      expect(typeof r.role_title).toBe('string');
      expect(r.role_title.length).toBeGreaterThan(0);
      expect(Array.isArray(r.key_responsibilities)).toBe(true);
    }

    process.env.BEDROCK_DEBUG_RAW_OUTPUT = originalEnv;
    jest.dontMock('@aws-sdk/client-bedrock-runtime');
  });
});
