import { jest } from '@jest/globals';

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

    const originalEnv = process.env.BEDROCK_DEBUG_RAW_OUTPUT;
    process.env.BEDROCK_DEBUG_RAW_OUTPUT = 'true';

    const mockSend = jest.fn(async () => {
      const bedrockJson = { content: [{ type: 'text', text: rawText }] };
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

    const svc = await import('../../src/services/bedrockService.js');

    const finalPersona = { skills_with_proficiency: [{ name: 'Python', proficiency: 80 }] };

    const result = await svc.getInitialRecommendations(finalPersona, {
      allowFallback: false
    });

    expect(result).toBeTruthy();
    expect(result.usedFallback).toBe(false);
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

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

  test('handles truncated output by salvaging the top-level role-object array (not nested arrays) and still returns 5 validated roles', async () => {
    // 5 complete role objects + a partial 6th object (simulates Bedrock truncation mid-object).
    const rawText = [
      '```json',
      '[',
      '  {',
      '    "title": "Full Stack Developer",',
      '    "industry": "Technology/Software Development",',
      '    "salary_lpa_range": "₹8–₹18 LPA",',
      '    "experience_range": "2–5 years",',
      '    "description": "Design and develop end-to-end web applications. Collaborate with teams to ship features.",',
      '    "key_responsibilities": [',
      '      "Build responsive web interfaces using React/Angular/Vue.js",',
      '      "Develop backend services with database integration",',
      '      "Implement CI/CD pipelines, testing, and code reviews"',
      '    ],',
      '    "required_skills": ["JavaScript","React","Node.js","SQL","Git"]',
      '  },',
      '  {',
      '    "title": "Machine Learning Engineer",',
      '    "industry": "AI/ML/Data Science",',
      '    "salary_lpa_range": "₹12–₹25 LPA",',
      '    "experience_range": "2–5 years",',
      '    "description": "Develop and deploy machine learning models. Improve performance with iteration.",',
      '    "key_responsibilities": ["Train models","Build pipelines","Monitor performance"],',
      '    "required_skills": ["Python","PyTorch","MLOps","Statistics","Data Analysis"]',
      '  },',
      '  {',
      '    "title": "AI/ML Product Engineer",',
      '    "industry": "Product Development/SaaS",',
      '    "salary_lpa_range": "₹15–₹30 LPA",',
      '    "experience_range": "3–6 years",',
      '    "description": "Build AI-powered features into applications. Ensure models are production-ready.",',
      '    "key_responsibilities": ["Prototype","Integrate","Iterate"],',
      '    "required_skills": ["Product Thinking","APIs","Machine Learning","JavaScript","Experimentation"]',
      '  },',
      '  {',
      '    "title": "Computer Vision Engineer",',
      '    "industry": "AI/Computer Vision/Imaging",',
      '    "salary_lpa_range": "₹10–₹22 LPA",',
      '    "experience_range": "2–5 years",',
      '    "description": "Develop computer vision solutions. Optimize for real-time performance.",',
      '    "key_responsibilities": ["OpenCV pipelines","Train models","Optimize inference"],',
      '    "required_skills": ["OpenCV","Deep Learning","Python","Optimization","Computer Vision"]',
      '  },',
      '  {',
      '    "title": "Data Engineer",',
      '    "industry": "Data Platforms",',
      '    "salary_lpa_range": "₹12–₹26 LPA",',
      '    "experience_range": "3–6 years",',
      '    "description": "Build reliable data pipelines. Enable analytics and ML workloads.",',
      '    "key_responsibilities": ["Pipelines","Model data","Quality checks"],',
      '    "required_skills": ["SQL","ETL","Data Modeling","Python","Cloud"]',
      '  },',
      '  {',
      '    "title": "TRUNCATED ROLE",',
      '    "industry": "Oops",',
      '    "salary_lpa_range": "₹1–₹2 LPA",',
      '    "key_responsibilities": ["one","two","three"]',
      '```'
    ].join('\n');

    const originalEnv = process.env.BEDROCK_DEBUG_RAW_OUTPUT;
    process.env.BEDROCK_DEBUG_RAW_OUTPUT = 'true';

    const mockSend = jest.fn(async () => {
      const bedrockJson = { content: [{ type: 'text', text: rawText }] };
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

    const svc = await import('../../src/services/bedrockService.js');

    const finalPersona = { skills_with_proficiency: [{ name: 'Python', proficiency: 80 }] };

    const result = await svc.getInitialRecommendations(finalPersona, { allowFallback: false });

    expect(result).toBeTruthy();
    expect(result.usedFallback).toBe(false);
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

    for (const r of result.roles) {
      expect(r && typeof r).toBe('object');
      expect(Array.isArray(r)).toBe(false);
      expect(typeof r.role_title).toBe('string');
      expect(r.role_title.length).toBeGreaterThan(0);
    }

    // Critical regression: ensure we did NOT accidentally extract nested key_responsibilities (string[]).
    expect(result.roles.some((x) => typeof x === 'string')).toBe(false);

    process.env.BEDROCK_DEBUG_RAW_OUTPUT = originalEnv;
    jest.dontMock('@aws-sdk/client-bedrock-runtime');
  });
});
