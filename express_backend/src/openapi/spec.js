

'use strict';

/**
 * OpenAPI 3.0 specification for this Express backend.
 *
 * We intentionally keep this spec close to the routes that exist today:
 * - /health, /health/db
 * - /documents (+ extracted text operations)
 * - /personas (+ persona version operations)
 *
 * Notes:
 * - Some endpoints may return 503 while database credentials are not configured.
 * - This spec documents that behavior explicitly via 503 responses.
 */

import swaggerJSDoc from 'swagger-jsdoc';

const openapiDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Professional Persona Builder API (Express)',
    version: '0.1.0',
    description:
      'Express backend for constructing professional personas from documents. Includes document metadata + extracted text persistence, plus persona/version scaffolding. Database connectivity is env-driven and may be unavailable during early scaffolding.'
  },
  tags: [
    { name: 'Health', description: 'Service health and readiness endpoints.' },
    { name: 'Builds', description: 'Build/workflow orchestration (create + status/progress polling).' },
    {
      name: 'Orchestration',
      description:
        'Convenience APIs that compose uploads, extraction/normalization, and persona draft/finalization into a single workflow. Safe without DB or external AI credentials.'
    },
    { name: 'Documents', description: 'Document metadata and extracted text persistence.' },
    { name: 'Uploads', description: 'Multi-file upload endpoints (placeholder; no persistence yet).' },
    { name: 'Extraction', description: 'PDF/TXT text extraction and text normalization (placeholders).' },
    { name: 'AI', description: 'AI persona generation (placeholder endpoints; safe without DB credentials).' },
    { name: 'Personas', description: 'Persona CRUD and version history.' },

    // Career Navigator /api endpoints
    { name: 'Recommendations', description: 'Role recommendations and comparisons (placeholder endpoints).' },
    { name: 'Paths', description: 'Career path exploration endpoints (placeholder endpoints).' },
    { name: 'Plan', description: 'Planning/milestones endpoints (placeholder endpoints).' },
    { name: 'Profile', description: 'Profile scoring endpoints (placeholder endpoints).' },
    { name: 'Roles', description: 'Roles catalog search and selection endpoints.' },
    { name: 'MindMap', description: 'Mind map graph endpoints for interactive career path exploration.' }
  ],
  servers: [
    {
      url: '/',
      description: 'Current server'
    }
  ],
  components: {
    schemas: {
      ErrorResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          error: { type: 'string', description: 'Machine readable error code.' },
          message: { type: 'string', nullable: true, description: 'Human readable message.' },
          details: { type: 'object', nullable: true, description: 'Optional validation/details object.' }
        },
        required: ['error']
      },
      HealthStatus: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', example: 'ok' }
        },
        required: ['status']
      },

      DocumentCreateRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userId: { type: 'string', format: 'uuid', nullable: true },
          originalFilename: { type: 'string', minLength: 1 },
          mimeType: { type: 'string', nullable: true },
          source: { type: 'string', nullable: true },
          storageProvider: { type: 'string', nullable: true },
          storagePath: { type: 'string', nullable: true },
          fileSizeBytes: { type: 'integer', minimum: 0, nullable: true },
          sha256: { type: 'string', nullable: true, description: 'Optional hash of file contents.' }
        },
        required: ['originalFilename']
      },
      Document: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid', nullable: true },
          originalFilename: { type: 'string' },
          mimeType: { type: 'string', nullable: true },
          source: { type: 'string', nullable: true },
          storageProvider: { type: 'string', nullable: true },
          storagePath: { type: 'string', nullable: true },
          fileSizeBytes: { type: 'integer', nullable: true },
          sha256: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'originalFilename', 'createdAt', 'updatedAt']
      },

      ExtractedTextUpsertRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          extractor: { type: 'string', nullable: true },
          extractorVersion: { type: 'string', nullable: true },
          language: { type: 'string', nullable: true },
          textContent: { type: 'string', minLength: 1 },
          metadataJson: {
            type: 'object',
            additionalProperties: true,
            description: 'Arbitrary metadata emitted by an extractor.'
          }
        },
        required: ['textContent']
      },
      DocumentExtractedText: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          documentId: { type: 'string', format: 'uuid' },
          extractor: { type: 'string', nullable: true },
          extractorVersion: { type: 'string', nullable: true },
          language: { type: 'string', nullable: true },
          textContent: { type: 'string' },
          metadataJson: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'documentId', 'textContent', 'createdAt']
      },

      PersonaCreateRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userId: { type: 'string', format: 'uuid', nullable: true },
          title: { type: 'string', nullable: true },
          personaJson: { type: 'object', additionalProperties: true, nullable: true }
        }
      },
      PersonaUpdateRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', nullable: true },
          personaJson: { type: 'object', additionalProperties: true, nullable: true }
        }
      },
      Persona: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid', nullable: true },
          title: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'createdAt', 'updatedAt']
      },
      PersonaVersionCreateRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'integer', minimum: 1, nullable: true },
          personaJson: { type: 'object', additionalProperties: true }
        },
        required: ['personaJson']
      },
      PersonaVersion: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          personaId: { type: 'string', format: 'uuid' },
          version: { type: 'integer', minimum: 1 },
          personaJson: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'personaId', 'version', 'personaJson', 'createdAt']
      },
      PersonaUpdateResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          persona: { $ref: '#/components/schemas/Persona' },
          createdVersion: { $ref: '#/components/schemas/PersonaVersion', nullable: true }
        },
        required: ['persona', 'createdVersion']
      },
      PersonaVersionsListResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          personaId: { type: 'string', format: 'uuid' },
          versions: { type: 'array', items: { $ref: '#/components/schemas/PersonaVersion' } }
        },
        required: ['personaId', 'versions']
      },

      PersonaDraftArtifact: {
        type: 'object',
        additionalProperties: false,
        description: 'Latest saved persona draft artifact (DB-backed when available; memory fallback otherwise).',
        properties: {
          personaId: { type: 'string', format: 'uuid' },
          draftId: { type: 'string', format: 'uuid', nullable: true },
          draftJson: { type: 'object', additionalProperties: true },
          updatedAt: { type: 'string', format: 'date-time' }
        },
        required: ['personaId', 'draftJson', 'updatedAt']
      },

      PersonaFinalArtifact: {
        type: 'object',
        additionalProperties: false,
        description: 'Latest saved finalized persona artifact (DB-backed when available; memory fallback otherwise).',
        properties: {
          personaId: { type: 'string', format: 'uuid' },
          finalId: { type: 'string', format: 'uuid', nullable: true },
          finalJson: { type: 'object', additionalProperties: true },
          updatedAt: { type: 'string', format: 'date-time' }
        },
        required: ['personaId', 'finalJson', 'updatedAt']
      },

      UploadFileResult: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fieldname: { type: 'string', description: 'Multipart field name.' },
          originalname: { type: 'string', description: 'Client-provided original filename.' },
          mimetype: { type: 'string', description: 'Client-provided mime type.' },
          size: { type: 'integer', minimum: 0, description: 'Size in bytes as received by the server.' }
        },
        required: ['fieldname', 'originalname', 'mimetype', 'size']
      },
      MultiFileUploadResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uploadId: { type: 'string', format: 'uuid', description: 'Server-generated upload batch id.' },
          receivedFiles: {
            type: 'array',
            items: { $ref: '#/components/schemas/UploadFileResult' },
            description:
              'Files accepted by the server. Note: upload endpoints also trigger automatic persistence + extraction as side effects, but this response intentionally does not include created document ids or extracted_text ids (existing contract remains stable).'
          },
          message: { type: 'string', description: 'Human-readable status message.' }
        },
        required: ['uploadId', 'receivedFiles', 'message']
      },

      ExtractTextRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filename: { type: 'string', description: 'Optional client filename for tracing.' },
          mimeType: { type: 'string', description: 'Optional mime type hint.' },
          content: {
            type: 'string',
            minLength: 1,
            description:
              'Raw content as text. Placeholder: for PDFs this should be plain text until multipart/base64 is introduced.'
          },
          languageHint: { type: 'string', description: 'Optional language hint, e.g. "en".' }
        },
        required: ['content']
      },
      ExtractTextResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          extractor: { type: 'string', example: 'placeholder' },
          extractorVersion: { type: 'string', example: '0.1.0' },
          sourceType: { type: 'string', enum: ['pdf', 'txt'] },
          language: { type: 'string', nullable: true },
          text: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', additionalProperties: true }
        },
        required: ['requestId', 'extractor', 'extractorVersion', 'sourceType', 'language', 'text', 'warnings', 'metadata']
      },

      NormalizeTextRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', minLength: 1 },
          options: {
            type: 'object',
            nullable: true,
            additionalProperties: false,
            properties: {
              removeExtraWhitespace: { type: 'boolean', nullable: true },
              normalizeLineBreaks: { type: 'boolean', nullable: true },
              maxLength: { type: 'integer', minimum: 1, nullable: true }
            }
          }
        },
        required: ['text']
      },
      NormalizeTextResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          text: { type: 'string' },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              originalLength: { type: 'integer', minimum: 0 },
              normalizedLength: { type: 'integer', minimum: 0 }
            },
            required: ['originalLength', 'normalizedLength']
          }
        },
        required: ['requestId', 'text', 'stats']
      },

      PersonaGenerateRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userId: { type: 'string', format: 'uuid', nullable: true },
          documentId: {
            type: 'string',
            format: 'uuid',
            nullable: true,
            description:
              'Optional document id. Reserved for future DB-backed behavior; placeholder does not read from DB.'
          },
          sourceText: {
            type: 'string',
            nullable: true,
            description:
              'Extracted/normalized text used as input. Recommended for placeholder behavior to remain DB-independent.'
          },
          context: {
            type: 'object',
            nullable: true,
            additionalProperties: false,
            properties: {
              targetRole: { type: 'string', nullable: true },
              seniority: { type: 'string', nullable: true },
              industry: { type: 'string', nullable: true }
            }
          },
          outputFormat: { type: 'string', enum: ['json'], nullable: true }
        },
        description:
          'Request to generate a persona. Must include at least one of sourceText or documentId.'
      },
      PersonaDraft: {
        type: 'object',
        additionalProperties: false,
        description:
          'Generated persona JSON draft. This schema is strict and matches the Zod PersonaDraftSchema used by POST /ai/personas/generate.',
        properties: {
          schemaVersion: { type: 'string', minLength: 1, description: 'Persona schema version string.' },
          title: { type: 'string', minLength: 1, description: 'Human-readable persona title.' },
          summary: { type: 'string', minLength: 1, description: 'Short summary of the persona.' },
          profile: {
            type: 'object',
            additionalProperties: false,
            description: 'Core profile attributes for the persona.',
            properties: {
              headline: { type: 'string', minLength: 1, description: 'Primary headline for the persona.' },
              seniority: { type: 'string', nullable: true, description: 'Optional seniority (nullable).' },
              industry: { type: 'string', nullable: true, description: 'Optional industry (nullable).' },
              location: { type: 'string', nullable: true, description: 'Optional location (nullable).' }
            },
            required: ['headline', 'seniority', 'industry', 'location']
          },
          strengths: {
            type: 'array',
            description: 'Key strengths. Must contain at least one non-empty string.',
            items: { type: 'string', minLength: 1 },
            minItems: 1
          },
          skills: {
            type: 'array',
            description: 'Key skills. Must contain at least one non-empty string.',
            items: { type: 'string', minLength: 1 },
            minItems: 1
          },
          experienceHighlights: {
            type: 'array',
            description: 'Experience highlights. Must contain at least one non-empty string.',
            items: { type: 'string', minLength: 1 },
            minItems: 1
          },
          provenance: {
            type: 'object',
            additionalProperties: false,
            description: 'Metadata about how the persona was generated.',
            properties: {
              source: { type: 'string', minLength: 1, description: 'Generator/source identifier.' },
              sourceTextLength: {
                type: 'integer',
                minimum: 0,
                description: 'Length of the source text used to generate the persona.'
              }
            },
            required: ['source', 'sourceTextLength']
          }
        },
        required: [
          'schemaVersion',
          'title',
          'summary',
          'profile',
          'strengths',
          'skills',
          'experienceHighlights',
          'provenance'
        ]
      },
      PersonaGenerateResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          mode: { type: 'string', example: 'placeholder' },
          warnings: { type: 'array', items: { type: 'string' } },
          persona: { $ref: '#/components/schemas/PersonaDraft' }
        },
        required: ['requestId', 'mode', 'warnings', 'persona']
      },

      BuildCreateRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          personaId: { type: 'string', format: 'uuid', nullable: true, description: 'Optional persona id to build/update.' },
          documentId: { type: 'string', format: 'uuid', nullable: true, description: 'Optional source document id for extraction.' },
          mode: { type: 'string', enum: ['persona_build', 'workflow'], nullable: true, description: 'Scaffold hint for future orchestration.' }
        }
      },
      BuildRecord: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          personaId: { type: 'string', format: 'uuid', nullable: true },
          documentId: { type: 'string', format: 'uuid', nullable: true },
          status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
          progress: { type: 'integer', minimum: 0, maximum: 100 },
          message: { type: 'string', nullable: true },
          steps: { type: 'array', items: { type: 'string' } },
          currentStep: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'status', 'progress', 'steps', 'createdAt', 'updatedAt']
      },
      BuildCreateResponse: {
        type: 'object',
        additionalProperties: false,
        allOf: [{ $ref: '#/components/schemas/BuildRecord' }],
        properties: {
          persistence: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', example: 'memory' },
              dbConfigured: { type: 'boolean', description: 'Whether DB env vars appear set (scaffold informational flag).' }
            },
            required: ['type', 'dbConfigured']
          }
        }
      },
      BuildStatus: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
          progress: { type: 'integer', minimum: 0, maximum: 100 },
          message: { type: 'string', nullable: true },
          currentStep: { type: 'string', nullable: true },
          updatedAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'status', 'progress', 'updatedAt']
      },

      OrchestrationStartRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['persona_build', 'workflow'], nullable: true },
          userId: { type: 'string', format: 'uuid', nullable: true },
          personaId: { type: 'string', format: 'uuid', nullable: true },
          documentIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          context: {
            type: 'object',
            nullable: true,
            additionalProperties: false,
            properties: {
              targetRole: { type: 'string', nullable: true },
              seniority: { type: 'string', nullable: true },
              industry: { type: 'string', nullable: true }
            }
          },
          autoCreatePersona: { type: 'boolean', nullable: true }
        }
      },
      OrchestrationStartResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          build: { $ref: '#/components/schemas/BuildCreateResponse' },
          orchestration: { $ref: '#/components/schemas/OrchestrationRecord' }
        },
        required: ['build', 'orchestration']
      },

      OrchestrationUploadLinkRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uploadId: { type: 'string', format: 'uuid' },
          documentIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 }
        },
        required: ['uploadId', 'documentIds']
      },

      OrchestrationExtractRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          normalize: {
            type: 'object',
            additionalProperties: false,
            properties: {
              removeExtraWhitespace: { type: 'boolean', nullable: true },
              normalizeLineBreaks: { type: 'boolean', nullable: true },
              maxLength: { type: 'integer', minimum: 1, nullable: true }
            }
          },
          persistToDocuments: { type: 'boolean', nullable: true }
        }
      },
      OrchestrationExtractResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          buildId: { type: 'string', format: 'uuid' },
          documentIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          normalizedText: { type: 'string' },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              originalLength: { type: 'integer', minimum: 0 },
              normalizedLength: { type: 'integer', minimum: 0 }
            },
            required: ['originalLength', 'normalizedLength']
          },
          orchestration: { $ref: '#/components/schemas/OrchestrationRecord' }
        },
        required: ['buildId', 'documentIds', 'normalizedText', 'stats', 'orchestration']
      },

      OrchestrationGenerateDraftRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceTextOverride: { type: 'string', minLength: 1 },
          context: {
            type: 'object',
            nullable: true,
            additionalProperties: false,
            properties: {
              targetRole: { type: 'string', nullable: true },
              seniority: { type: 'string', nullable: true },
              industry: { type: 'string', nullable: true }
            }
          },
          personaId: { type: 'string', format: 'uuid' },
          saveDraft: { type: 'boolean', nullable: true },
          createVersion: { type: 'boolean', nullable: true }
        }
      },
      OrchestrationGenerateDraftResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          mode: { type: 'string', example: 'placeholder' },
          warnings: { type: 'array', items: { type: 'string' } },
          buildId: { type: 'string', format: 'uuid' },
          personaId: { type: 'string', format: 'uuid', nullable: true },
          persona: { $ref: '#/components/schemas/PersonaDraft' },
          savedDraft: { type: 'object', nullable: true, additionalProperties: true },
          createdVersion: { $ref: '#/components/schemas/PersonaVersion', nullable: true },
          orchestration: { $ref: '#/components/schemas/OrchestrationRecord' }
        },
        required: ['requestId', 'mode', 'warnings', 'buildId', 'personaId', 'persona', 'savedDraft', 'createdVersion', 'orchestration']
      },

      OrchestrationFinalizeRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          finalOverride: {
            type: 'object',
            additionalProperties: true,
            description: 'If provided, overrides the draft as the final persona JSON.'
          },
          personaId: { type: 'string', format: 'uuid' },
          saveFinal: { type: 'boolean', nullable: true },
          createVersion: { type: 'boolean', nullable: true }
        }
      },
      OrchestrationFinalizeResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          buildId: { type: 'string', format: 'uuid' },
          personaId: { type: 'string', format: 'uuid', nullable: true },
          final: { type: 'object', additionalProperties: true },
          savedFinal: { type: 'object', nullable: true, additionalProperties: true },
          createdVersion: { $ref: '#/components/schemas/PersonaVersion', nullable: true },
          orchestration: { $ref: '#/components/schemas/OrchestrationRecord' }
        },
        required: ['buildId', 'personaId', 'final', 'savedFinal', 'createdVersion', 'orchestration']
      },

      OrchestrationRecord: {
        type: 'object',
        additionalProperties: true,
        description:
          'In-memory orchestration record that links build/workflow IDs to uploads, document IDs, normalized text, and persona draft/final JSON. Shape may evolve; this contract provides a stable envelope.'
      },

      OrchestrationRunAllRequest: {
        type: 'object',
        additionalProperties: false,
        description:
          'Single-call orchestration that starts a build, links documents, extracts+normalizes, generates a draft persona, and optionally finalizes. Progress can be polled via /builds/{id}/status and /orchestration/builds/{id}. Additive behavior: if documentIds/uploadLink are omitted, the service can auto-select the latest uploaded docs for the 3 primary categories (resume, job_description, performance_review) when useLatestCategoryDocs=true (default).',
        properties: {
          mode: { type: 'string', enum: ['persona_build', 'workflow'], nullable: true },
          userId: { type: 'string', format: 'uuid', nullable: true },
          personaId: { type: 'string', format: 'uuid', nullable: true },
          context: {
            type: 'object',
            nullable: true,
            additionalProperties: false,
            properties: {
              targetRole: { type: 'string', nullable: true },
              seniority: { type: 'string', nullable: true },
              industry: { type: 'string', nullable: true }
            }
          },

          // Existing options:
          uploadLink: { $ref: '#/components/schemas/OrchestrationUploadLinkRequest' },
          documentIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },

          // Additive option:
          useLatestCategoryDocs: {
            type: 'boolean',
            nullable: true,
            description:
              'If true (default), and uploadLink/documentIds are not provided, orchestration will load latest docs by category for the given userId.'
          },

          extract: { $ref: '#/components/schemas/OrchestrationExtractRequest' },
          generate: { $ref: '#/components/schemas/OrchestrationGenerateDraftRequest' },
          finalize: { $ref: '#/components/schemas/OrchestrationFinalizeRequest' },
          autoCreatePersona: { type: 'boolean', nullable: true }
        }
      },
      OrchestrationRunAllResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          build: { $ref: '#/components/schemas/BuildCreateResponse' },
          orchestration: { $ref: '#/components/schemas/OrchestrationRecord' },
          results: {
            type: 'object',
            additionalProperties: false,
            properties: {
              extract: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  documentIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
                  stats: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      originalLength: { type: 'integer', minimum: 0 },
                      normalizedLength: { type: 'integer', minimum: 0 }
                    },
                    required: ['originalLength', 'normalizedLength']
                  }
                },
                required: ['documentIds', 'stats']
              },
              generate: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  personaId: { type: 'string', format: 'uuid', nullable: true }
                },
                required: ['personaId']
              },
              finalize: {
                type: 'object',
                nullable: true,
                additionalProperties: false,
                properties: {
                  personaId: { type: 'string', format: 'uuid', nullable: true }
                },
                required: ['personaId']
              }
            },
            required: ['extract', 'generate', 'finalize']
          }
        },
        required: ['build', 'orchestration', 'results']
      },

      // --- /api/* placeholder endpoint schemas (Career Navigator) ---
      RecommendedRole: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: 'Role identifier (stable string id).' },
          title: { type: 'string', minLength: 1, description: 'Human-readable role title.' },
          description: { type: 'string', nullable: true },
          tags: { type: 'array', nullable: true, items: { type: 'string' } }
        },
        required: ['id', 'title']
      },
      RecommendationsRolesResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          roles: { type: 'array', items: { $ref: '#/components/schemas/RecommendedRole' } }
        },
        required: ['roles']
      },
      RoleCompareRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          leftRoleId: { type: 'string', minLength: 1 },
          rightRoleId: { type: 'string', minLength: 1 },
          context: { type: 'object', nullable: true, additionalProperties: true }
        },
        required: ['leftRoleId', 'rightRoleId']
      },
      RoleCompareResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          leftRoleId: { type: 'string' },
          rightRoleId: { type: 'string' },
          comparison: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              differences: { type: 'array', items: { type: 'string' } }
            },
            required: ['summary', 'differences']
          }
        },
        required: ['leftRoleId', 'rightRoleId', 'comparison']
      },

      CareerPath: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          steps: { type: 'array', items: { type: 'string', minLength: 1 } }
        },
        required: ['id', 'title', 'steps']
      },
      PathsMultiverseResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', items: { $ref: '#/components/schemas/CareerPath' } }
        },
        required: ['paths']
      },

      PlanMilestonesRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', nullable: true },
          timeframeWeeks: { type: 'integer', nullable: true, minimum: 1 },
          context: { type: 'object', nullable: true, additionalProperties: true }
        }
      },
      PlanMilestone: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', nullable: true },
          order: { type: 'integer', minimum: 1 }
        },
        required: ['id', 'title', 'order']
      },
      PlanMilestonesResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string' },
          timeframeWeeks: { type: 'integer' },
          milestones: { type: 'array', items: { $ref: '#/components/schemas/PlanMilestone' } }
        },
        required: ['goal', 'timeframeWeeks', 'milestones']
      },

      ProfileScoringRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userId: { type: 'string', nullable: true, description: 'Optional user identifier.' },
          scoring: { type: 'object', nullable: true, additionalProperties: true }
        }
      },
      ProfileScoringResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'] },
          scoring: { type: 'object', additionalProperties: true }
        },
        required: ['status', 'scoring']
      },

      RoleCatalogItem: {
        type: 'object',
        additionalProperties: false,
        properties: {
          role_id: { type: 'string', format: 'uuid' },
          role_title: { type: 'string' },
          industry: { type: 'string', nullable: true },
          skills_required: { type: 'array', items: { type: 'string' } },
          salary_range: { type: 'string', nullable: true }
        },
        required: ['role_id', 'role_title', 'industry', 'skills_required', 'salary_range']
      },
      RolesSearchResponse: {
        type: 'array',
        items: { $ref: '#/components/schemas/RoleCatalogItem' }
      },
      PersonaTargetRoleSelectRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          role_id: { type: 'string', format: 'uuid' },
          time_horizon: { type: 'string', enum: ['Near', 'Mid', 'Far'] }
        },
        required: ['user_id', 'role_id', 'time_horizon']
      },
      PersonaTargetRoleSelectResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'] },
          target: { type: 'object', additionalProperties: true }
        },
        required: ['status', 'target']
      },

      PersonaTargetRoleGetResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'] },
          target: { type: 'object', additionalProperties: true }
        },
        required: ['status', 'target']
      },

      MindMapNode: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['current_role', 'role'] },
          label: { type: 'string', minLength: 1 },
          level: { type: 'integer', minimum: 0 },
          data: { type: 'object', additionalProperties: true }
        },
        required: ['id', 'type', 'label', 'level', 'data']
      },

      MindMapEdge: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          source: { type: 'string', minLength: 1 },
          target: { type: 'string', minLength: 1 },
          type: { type: 'string', example: 'progression' },
          label: { type: 'string', nullable: true },
          data: { type: 'object', additionalProperties: true }
        },
        required: ['id', 'source', 'target', 'type', 'data']
      },

      MindMapNodeDetails: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          industry: { type: 'string', nullable: true },
          requiredSkills: { type: 'array', items: { type: 'string' } },
          averageSalary: { type: 'string', nullable: true },
          transitionTimeline: { type: 'string', nullable: true },
          skillGap: { type: 'object', additionalProperties: true }
        },
        required: ['id', 'title', 'requiredSkills', 'averageSalary', 'transitionTimeline', 'skillGap']
      },

      MindMapGraphResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          meta: { type: 'object', additionalProperties: true },
          nodes: { type: 'array', items: { $ref: '#/components/schemas/MindMapNode' } },
          edges: { type: 'array', items: { $ref: '#/components/schemas/MindMapEdge' } },
          detailsByNodeId: { type: 'object', additionalProperties: { $ref: '#/components/schemas/MindMapNodeDetails' } }
        },
        required: ['meta', 'nodes', 'edges', 'detailsByNodeId']
      }
    },
    parameters: {
      DocumentIdParam: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
        description: 'Document identifier.'
      },
      PersonaIdParam: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
        description: 'Persona identifier.'
      },
      BuildIdParam: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
        description: 'Build/workflow identifier.'
      },
      OrchestrationBuildIdParam: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
        description: 'Build/workflow identifier (used for orchestration endpoints).'
      }
    }
  },
  paths: {
    '/': {
      get: {
        tags: ['Health'],
        summary: 'Service root',
        description: 'Lightweight root endpoint with service name/status.',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    status: { type: 'string' }
                  },
                  required: ['name', 'status']
                }
              }
            }
          }
        }
      }
    },

    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Returns status=ok when the service is running.',
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthStatus' } } }
          }
        }
      }
    },
    '/health/db': {
      get: {
        tags: ['Health'],
        summary: 'Database connectivity check',
        description:
          'Attempts a trivial query to check DB connectivity. Returns 503 if DB is not configured or not reachable.',
        responses: {
          200: {
            description: 'DB OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    db: { type: 'object', additionalProperties: true }
                  },
                  required: ['status', 'db']
                }
              }
            }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/uploads/documents': {
      post: {
        tags: ['Uploads'],
        summary: 'Upload one or more documents (multi-file upload)',
        description:
          [
            'Uploads one or more documents via multipart/form-data (field name: `files`).',
            '',
            'Category tagging (used by orchestration auto-selection):',
            '- Canonical categories: `resume`, `job_description`, `performance_review`.',
            '- You may provide categories using ONE of the additive patterns below (all are optional).',
            '- Precedence (highest → lowest): `category` → `categoryByIndexJson` → `categoriesJson` → `categoryByOriginalnameJson`.',
            '',
            'Automatic side effects (contract-stable):',
            '- For each accepted file the server persists a `documents` metadata row (no blobs).',
            '- Then it attempts extraction + normalization and (best-effort) creates **one `extracted_text` row per uploaded document**.',
            '- The HTTP response contract remains stable and only returns `uploadId`, `receivedFiles`, and a `message` (no document ids).'
          ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  files: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                    description:
                      'One or more files. Must be sent with multipart field name `files` (i.e., `files[]` in many clients).'
                  },
                  userId: { type: 'string', format: 'uuid', nullable: true, description: 'Optional user id.' },
                  source: {
                    type: 'string',
                    nullable: true,
                    description:
                      'Optional source label for metadata (e.g., resume, linkedin). Does not affect extraction.'
                  },

                  category: {
                    type: 'string',
                    nullable: true,
                    enum: ['resume', 'job_description', 'performance_review'],
                    description:
                      'Apply a single category to ALL uploaded files in this request. Canonical categories are used for orchestration auto-selection.'
                  },
                  categoriesJson: {
                    type: 'string',
                    nullable: true,
                    description:
                      'JSON array of category strings aligned with upload order (index-based). Example: `["resume","job_description","performance_review"]`.'
                  },
                  categoryByOriginalnameJson: {
                    type: 'string',
                    nullable: true,
                    description:
                      'JSON object mapping original filename to category. Example: `{"resume.pdf":"resume"}`.'
                  },
                  categoryByIndexJson: {
                    type: 'string',
                    nullable: true,
                    description:
                      'JSON object mapping file index to category. Example: `{"0":"resume","1":"job_description"}`.'
                  },
                  requireCategories: {
                    type: 'string',
                    nullable: true,
                    description:
                      'If `"true"`, the server validates that the request includes at least one file for EACH canonical category: resume, job_description, performance_review.'
                  }
                },
                required: ['files']
              }
            }
          }
        },
        responses: {
          200: {
            description:
              'Upload accepted. Side effects: persists a `documents` row per file and attempts extraction+normalization, creating one `extracted_text` row per uploaded document when possible (best-effort). Response contract stays stable (no created ids returned).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MultiFileUploadResponse' } }
            }
          },
          400: {
            description: 'Validation error (e.g., missing files, invalid/missing required categories)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          413: {
            description: 'Payload too large',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/uploads/text': {
      post: {
        tags: ['Uploads'],
        summary: 'Upload one or more plain text files (multi-file upload)',
        description:
          [
            'Uploads one or more text files via multipart/form-data (field name: `files`).',
            '',
            'Category tagging (used by orchestration auto-selection):',
            '- Canonical categories: `resume`, `job_description`, `performance_review`.',
            '- Precedence (highest → lowest): `category` → `categoryByIndexJson` → `categoriesJson` → `categoryByOriginalnameJson`.',
            '',
            'Automatic side effects (contract-stable):',
            '- For each accepted file the server persists a `documents` metadata row (no blobs).',
            '- Then it attempts extraction + normalization and (best-effort) creates **one `extracted_text` row per uploaded document**.',
            '- The HTTP response contract remains stable and only returns `uploadId`, `receivedFiles`, and a `message` (no document ids).'
          ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  files: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                    description:
                      'One or more text files. Must be sent with multipart field name `files` (i.e., `files[]` in many clients).'
                  },
                  userId: { type: 'string', format: 'uuid', nullable: true },

                  category: {
                    type: 'string',
                    nullable: true,
                    enum: ['resume', 'job_description', 'performance_review'],
                    description:
                      'Apply a single category to ALL uploaded files in this request. Canonical categories are used for orchestration auto-selection.'
                  },
                  categoriesJson: {
                    type: 'string',
                    nullable: true,
                    description:
                      'JSON array of category strings aligned with upload order (index-based). Example: `["resume","job_description","performance_review"]`.'
                  },
                  categoryByOriginalnameJson: {
                    type: 'string',
                    nullable: true,
                    description:
                      'JSON object mapping original filename to category. Example: `{"review.txt":"performance_review"}`.'
                  },
                  categoryByIndexJson: {
                    type: 'string',
                    nullable: true,
                    description:
                      'JSON object mapping file index to category. Example: `{"0":"resume","1":"job_description"}`.'
                  },
                  requireCategories: {
                    type: 'string',
                    nullable: true,
                    description:
                      'If `"true"`, the server validates that the request includes at least one file for EACH canonical category: resume, job_description, performance_review.'
                  }
                },
                required: ['files']
              }
            }
          }
        },
        responses: {
          200: {
            description:
              'Upload accepted. Side effects: persists a `documents` row per file and attempts extraction+normalization, creating one `extracted_text` row per uploaded document when possible (best-effort). Response contract stays stable (no created ids returned).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MultiFileUploadResponse' } }
            }
          },
          400: {
            description: 'Validation error (e.g., missing files, invalid/missing required categories)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          413: {
            description: 'Payload too large',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/extraction/pdf/extract-text': {
      post: {
        tags: ['Extraction'],
        summary: 'Extract text from a PDF payload (placeholder)',
        description:
          'Placeholder endpoint for PDF text extraction. For now, expects plain text in `content` (not PDF bytes). Future versions may accept multipart/form-data or base64-encoded PDF bytes.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ExtractTextRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Extracted text (placeholder)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ExtractTextResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/extraction/txt/extract-text': {
      post: {
        tags: ['Extraction'],
        summary: 'Extract text from a TXT payload (placeholder)',
        description:
          'Extracts/normalizes text from a plain text payload. This is close to real behavior for TXT; it normalizes line breaks.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ExtractTextRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Extracted text',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ExtractTextResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/extraction/normalize': {
      post: {
        tags: ['Extraction'],
        summary: 'Normalize extracted text (placeholder)',
        description:
          'Normalizes text for downstream processing (whitespace cleanup, line break normalization, optional truncation).',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NormalizeTextRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Normalized text',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/NormalizeTextResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/ai/personas/generate': {
      post: {
        tags: ['AI'],
        summary: 'Generate a professional persona JSON (placeholder)',
        description:
          'Safe placeholder for AI persona generation. Does not call external AI services and does not read/write the database. Provide sourceText for DB-independent usage. documentId is reserved for future DB-backed behavior.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PersonaGenerateRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Generated persona draft (placeholder)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PersonaGenerateResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/builds': {
      post: {
        tags: ['Builds'],
        summary: 'Create a build/workflow (scaffold)',
        description:
          'Creates a build/workflow and starts a placeholder progress simulation suitable for status polling. This scaffold stores state in memory only.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/BuildCreateRequest' } }
          }
        },
        responses: {
          201: {
            description: 'Build created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildCreateResponse' } } }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/builds/{id}': {
      get: {
        tags: ['Builds'],
        summary: 'Get build/workflow details',
        parameters: [{ $ref: '#/components/parameters/BuildIdParam' }],
        responses: {
          200: {
            description: 'Build record',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildRecord' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/builds/{id}/status': {
      get: {
        tags: ['Builds'],
        summary: 'Poll build/workflow status/progress',
        description: 'Polling-friendly status projection for a build/workflow.',
        parameters: [{ $ref: '#/components/parameters/BuildIdParam' }],
        responses: {
          200: {
            description: 'Status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildStatus' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/builds/{id}/cancel': {
      post: {
        tags: ['Builds'],
        summary: 'Cancel a build/workflow (scaffold)',
        description: 'Cancels a queued/running build. If already completed, returns current status.',
        parameters: [{ $ref: '#/components/parameters/BuildIdParam' }],
        responses: {
          200: {
            description: 'Status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildStatus' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/orchestration/start': {
      post: {
        tags: ['Orchestration'],
        summary: 'Start an orchestration session (creates a build/workflow)',
        description:
          'Creates a build/workflow and an in-memory orchestration record that can be used to link uploads/documents, derive normalized text, generate a draft persona, and finalize.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OrchestrationStartRequest' } }
          }
        },
        responses: {
          201: {
            description: 'Created build + orchestration record',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OrchestrationStartResponse' } }
            }
          },
          400: {
            description: 'Bad request / validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          422: {
            description: 'Unprocessable entity (domain/semantic validation failed)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/orchestration/run-all': {
      post: {
        tags: ['Orchestration'],
        summary: 'Run all orchestration steps end-to-end (one call)',
        description:
          'Starts a build/workflow and runs linking → extract/normalize → generate draft (→ optional finalize). Poll /builds/{id}/status for progress and /orchestration/builds/{id} for artifacts/step trace.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OrchestrationRunAllRequest' } }
          }
        },
        responses: {
          201: {
            description: 'Build started and orchestration completed (or started if downstream prerequisites missing)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OrchestrationRunAllResponse' } }
            }
          },
          400: {
            description: 'Bad request / validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          422: {
            description: 'Unprocessable entity (domain/semantic validation failed)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/orchestration/builds/{id}': {
      get: {
        tags: ['Orchestration'],
        summary: 'Get orchestration record for a build id',
        parameters: [{ $ref: '#/components/parameters/OrchestrationBuildIdParam' }],
        responses: {
          200: {
            description: 'Orchestration record',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OrchestrationRecord' } }
            }
          },
          400: {
            description: 'Bad request / validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          422: {
            description: 'Unprocessable entity (domain/semantic validation failed)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/orchestration/builds/{id}/link-upload': {
      post: {
        tags: ['Orchestration'],
        summary: 'Link an uploadId + documentIds to an existing build id',
        description:
          'Links an existing upload batch (uploadId) and corresponding documentIds to the build orchestration, enabling extract/normalize and draft generation steps.',
        parameters: [{ $ref: '#/components/parameters/OrchestrationBuildIdParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrchestrationUploadLinkRequest' }
            }
          }
        },
        responses: {
          200: {
            description: 'Updated orchestration record',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OrchestrationRecord' } }
            }
          },
          400: {
            description: 'Bad request / validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          422: {
            description: 'Unprocessable entity (domain/semantic validation failed)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/orchestration/builds/{id}/extract-normalize': {
      post: {
        tags: ['Orchestration'],
        summary: 'Derive combined normalized text for the build from linked documents',
        description:
          'Requires extracted text to already exist for the linked documents (e.g., via /uploads/* side effects or /documents/:id/extracted-text). Produces a normalized combined text blob.',
        parameters: [{ $ref: '#/components/parameters/OrchestrationBuildIdParam' }],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OrchestrationExtractRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Normalized text + updated orchestration',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OrchestrationExtractResponse' }
              }
            }
          },
          400: {
            description: 'Bad request / validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          422: {
            description: 'Unprocessable entity (domain/semantic validation failed)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/orchestration/builds/{id}/generate-draft': {
      post: {
        tags: ['Orchestration'],
        summary: 'Generate persona draft from normalized text (placeholder AI)',
        description:
          'Generates a schema-validated persona JSON draft. Does not call external AI services. Uses normalized text from prior steps or accepts a sourceTextOverride.',
        parameters: [{ $ref: '#/components/parameters/OrchestrationBuildIdParam' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrchestrationGenerateDraftRequest' }
            }
          }
        },
        responses: {
          200: {
            description: 'Draft persona + updated orchestration',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OrchestrationGenerateDraftResponse' }
              }
            }
          },
          400: {
            description: 'Bad request / validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          422: {
            description: 'Unprocessable entity (domain/semantic validation failed)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/orchestration/builds/{id}/finalize': {
      post: {
        tags: ['Orchestration'],
        summary: 'Finalize persona for a build (optionally save final + create version)',
        description:
          'Finalizes the persona JSON using the generated draft by default (or finalOverride). Optionally saves final persona and/or creates a persona version if personaId exists/was created.',
        parameters: [{ $ref: '#/components/parameters/OrchestrationBuildIdParam' }],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OrchestrationFinalizeRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Final persona + updated orchestration',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OrchestrationFinalizeResponse' }
              }
            }
          },
          400: {
            description: 'Bad request / validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          422: {
            description: 'Unprocessable entity (domain/semantic validation failed)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/documents': {
      get: {
        tags: ['Documents'],
        summary: 'List documents',
        description:
          'Lists document metadata records. Supports simple limit/offset pagination. Returns an array of Document.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, maximum: 1000, default: 100 },
            description: 'Maximum number of documents to return (default 100, max 1000).'
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, default: 0 },
            description: 'Offset for pagination (default 0).'
          }
        ],
        responses: {
          200: {
            description: 'Documents list',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Document' } }
              }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      },
      post: {
        tags: ['Documents'],
        summary: 'Create a document (metadata only)',
        description:
          'Creates a document metadata record. Uploading file bytes is out of scope for this step.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/DocumentCreateRequest' } }
          }
        },
        responses: {
          201: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/documents/{id}': {
      get: {
        tags: ['Documents'],
        summary: 'Get document by id',
        parameters: [{ $ref: '#/components/parameters/DocumentIdParam' }],
        responses: {
          200: {
            description: 'Document',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/documents/{id}/extracted-text': {
      get: {
        tags: ['Documents'],
        summary: 'Get latest extracted text for a document (alias)',
        description:
          'Alias for GET /documents/{id}/extracted-text/latest. Returns the most recently persisted extracted text row for the document.',
        parameters: [{ $ref: '#/components/parameters/DocumentIdParam' }],
        responses: {
          200: {
            description: 'Latest extracted text',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/DocumentExtractedText' } }
            }
          },
          404: {
            description: 'Document or extracted text not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      },
      post: {
        tags: ['Documents'],
        summary: 'Persist extracted text for a document',
        parameters: [{ $ref: '#/components/parameters/DocumentIdParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ExtractedTextUpsertRequest' } }
          }
        },
        responses: {
          201: {
            description: 'Created extracted text row',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/DocumentExtractedText' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Document not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/documents/{id}/extracted-text/latest': {
      get: {
        tags: ['Documents'],
        summary: 'Get latest extracted text for a document',
        parameters: [{ $ref: '#/components/parameters/DocumentIdParam' }],
        responses: {
          200: {
            description: 'Latest extracted text',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/DocumentExtractedText' } }
            }
          },
          404: {
            description: 'Document or extracted text not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/personas': {
      post: {
        tags: ['Personas'],
        summary: 'Create a persona',
        description:
          'Creates a persona row. If personaJson is provided, version 1 may be created as well (scaffold behavior).',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PersonaCreateRequest' } } }
        },
        responses: {
          201: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Persona' } } }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (not configured yet)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/personas/{id}': {
      get: {
        tags: ['Personas'],
        summary: 'Get persona by id',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        responses: {
          200: {
            description: 'Persona',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Persona' } } }
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (not configured yet)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      },
      put: {
        tags: ['Personas'],
        summary: 'Update persona metadata and optionally create a new version',
        description:
          'Updates persona metadata (e.g., title). If personaJson is provided, creates a new persona version.',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PersonaUpdateRequest' } } }
        },
        responses: {
          200: {
            description: 'Updated + optional created version',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PersonaUpdateResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Persona not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (not configured yet)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/personas/{id}/versions': {
      post: {
        tags: ['Personas'],
        summary: 'Create a persona version',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PersonaVersionCreateRequest' } }
          }
        },
        responses: {
          201: {
            description: 'Created version',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PersonaVersion' } } }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Persona not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (not configured yet)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      },
      get: {
        tags: ['Personas'],
        summary: 'List persona versions',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        responses: {
          200: {
            description: 'Versions list',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PersonaVersionsListResponse' } }
            }
          },
          404: {
            description: 'Persona not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (not configured yet)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/personas/{id}/versions/latest': {
      get: {
        tags: ['Personas'],
        summary: 'Get latest persona version',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        responses: {
          200: {
            description: 'Latest version',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PersonaVersion' } } }
          },
          404: {
            description: 'Persona or version not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (not configured yet)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/personas/{id}/draft/latest': {
      get: {
        tags: ['Personas'],
        summary: 'Get latest saved persona draft artifact',
        description:
          'Returns the latest saved draft JSON for the persona (backed by MySQL persona_drafts when configured, otherwise memory).',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        responses: {
          200: {
            description: 'Latest saved draft artifact',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PersonaDraftArtifact' } } }
          },
          404: {
            description: 'Persona or draft not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (if configured but unreachable)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      },
      put: {
        tags: ['Personas'],
        summary: 'Save edited persona draft JSON',
        description:
          'Persists edited draft JSON for the persona. Request body may be {draftJson: object} or a raw JSON object (draft itself).',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Saved draft artifact',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PersonaDraftArtifact' } } }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Persona not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (if configured but unreachable)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/personas/{id}/final/latest': {
      get: {
        tags: ['Personas'],
        summary: 'Get latest finalized persona artifact',
        description:
          'Returns the latest finalized persona JSON for the persona (backed by MySQL persona_final when configured, otherwise memory).',
        parameters: [{ $ref: '#/components/parameters/PersonaIdParam' }],
        responses: {
          200: {
            description: 'Latest finalized persona artifact',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PersonaFinalArtifact' } } }
          },
          404: {
            description: 'Persona or final artifact not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable (if configured but unreachable)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    // ----------------------------
    // Career Navigator /api routes
    // ----------------------------

    '/api/recommendations/initial': {
      get: {
        tags: ['Recommendations'],
        summary: 'Initial persona-driven recommendations (5 roles)',
        description:
          'Loads the Finalized Persona by personaId and returns EXACTLY 5 personalized role recommendations generated via AWS Bedrock, including compatibilityScore + threeTwoReport.',
        parameters: [
          {
            name: 'personaId',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1 },
            description: 'Persona identifier used to load the Finalized Persona JSON.'
          }
        ],
        responses: {
          200: {
            description: 'Initial recommendations (exactly 5 roles)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    roles: {
                      type: 'array',
                      minItems: 5,
                      maxItems: 5,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          role_id: { type: 'string', minLength: 1 },
                          role_title: { type: 'string', minLength: 1 },
                          industry: { type: 'string', minLength: 1 },
                          salary_lpa_range: { type: 'string', minLength: 1, example: '₹18–₹30 LPA' },
                          experience_range: { type: 'string', nullable: true, example: '3–5 years' },
                          description: {
                            type: 'string',
                            nullable: true,
                            example:
                              'Designs and builds backend services and APIs for high-traffic applications. Focuses on reliability, performance, and clean integration patterns.'
                          },
                          key_responsibilities: {
                            type: 'array',
                            items: { type: 'string' },
                            minItems: 0,
                            example: [
                              'Build and maintain high-throughput APIs and background jobs',
                              'Optimize data models and query performance for scale',
                              'Implement monitoring, alerting, and incident-ready runbooks'
                            ]
                          },
                          required_skills: {
                            type: 'array',
                            items: { type: 'string' },
                            minItems: 1,
                            example: ['Node.js', 'Express', 'SQL', 'API Design', 'System Design', 'Observability']
                          },
                          compatibilityScore: { type: 'number', minimum: 0, maximum: 100, example: 74 },
                          threeTwoReport: {
                            type: 'object',
                            additionalProperties: true,
                            description: 'Report produced by scoringEngine.buildThreeTwoReport.'
                          },
                          match_metadata: {
                            type: 'object',
                            additionalProperties: true,
                            description: 'Metadata about scoring and Bedrock fallback/model id.'
                          }
                        },
                        required: [
                          'role_id',
                          'role_title',
                          'industry',
                          'salary_lpa_range',
                          'experience_range',
                          'description',
                          'key_responsibilities',
                          'required_skills',
                          'compatibilityScore',
                          'threeTwoReport',
                          'match_metadata'
                        ]
                      }
                    },
                    meta: { type: 'object', nullable: true, additionalProperties: true }
                  },
                  required: ['roles']
                },
                example: {
                  roles: [
                    {
                      role_id: 'bedrock-rec-backend-engineer-node-js',
                      role_title: 'Backend Engineer (Node.js)',
                      industry: 'Technology',
                      salary_lpa_range: '₹22–₹38 LPA',
                      experience_range: '3–6 years',
                      description:
                        'Designs and operates scalable backend services and APIs used by multiple product surfaces. Focuses on performance, reliability, and observability in production.',
                      key_responsibilities: [
                        'Build and maintain high-throughput APIs',
                        'Optimize database queries and service performance',
                        'Implement monitoring, logging, and on-call readiness'
                      ],
                      required_skills: ['Node.js', 'Express', 'SQL', 'API Design', 'Performance Tuning', 'Observability'],
                      compatibilityScore: 78,
                      threeTwoReport: { status: 'ok' },
                      match_metadata: { source: 'bedrock_initial_recommendations', bedrockUsedFallback: false }
                    }
                  ],
                  meta: { bedrockUsedFallback: false }
                }
              }
            }
          },
          400: {
            description: 'Missing personaId',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Final persona not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          502: {
            description: 'Upstream AI failure',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'Service unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/api/recommendations/roles': {
      get: {
        tags: ['Recommendations'],
        summary: 'List recommended roles (placeholder)',
        description: 'Returns a curated list of recommended roles. Safe placeholder: no DB and no external AI calls.',
        responses: {
          200: {
            description: 'Recommended roles',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RecommendationsRolesResponse' } }
            }
          }
        }
      }
    },

    '/api/recommendations/compare': {
      post: {
        tags: ['Recommendations'],
        summary: 'Compare two roles (placeholder)',
        description:
          'Compares two roles based on role ids. Safe placeholder: deterministic output; future versions may be AI-backed.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RoleCompareRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Comparison result',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RoleCompareResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/api/paths/multiverse': {
      get: {
        tags: ['Paths'],
        summary: 'List possible career paths (placeholder)',
        description: 'Returns a deterministic set of example career paths.',
        responses: {
          200: {
            description: 'Career paths',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PathsMultiverseResponse' } }
            }
          }
        }
      }
    },

    '/api/plan/milestones': {
      post: {
        tags: ['Plan'],
        summary: 'Derive plan milestones (placeholder)',
        description:
          'Derives a milestone plan from an optional goal/timeframe. Safe placeholder: no DB and no external AI calls.',
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PlanMilestonesRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Derived milestones',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PlanMilestonesResponse' } }
            }
          }
        }
      }
    },

    '/api/profile/scoring': {
      put: {
        tags: ['Profile'],
        summary: 'Update profile scoring (placeholder)',
        description:
          'Updates profile scoring inputs/results. Safe placeholder endpoint that echoes scoring with a default overall score.',
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProfileScoringRequest' } }
          }
        },
        responses: {
          200: {
            description: 'Updated scoring',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProfileScoringResponse' } }
            }
          }
        }
      }
    },

    '/api/roles/search': {
      get: {
        tags: ['Roles'],
        summary: 'Search roles catalog (safe-fail)',
        description:
          'Search roles by query string and optional persona context. IMPORTANT: This endpoint is designed to fail safely by returning an empty array (HTTP 200) on internal errors/upstream failures, to protect the Explore UI.',
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'personaId',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Optional persona identifier used for persona-driven exploration search.'
          },
          {
            name: 'persona_id',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Legacy alias of personaId.'
          },
          { name: 'industry', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'salary_range', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } }
        ],
        responses: {
          200: {
            description:
              'Roles search results (array). Note: on internal errors this endpoint returns [] with HTTP 200 (safe-fail contract).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RolesSearchResponse' } }
            }
          }
        }
      }
    },

    '/api/roles/industries': {
      get: {
        tags: ['Roles'],
        summary: 'List distinct industries for role filtering',
        description:
          'Returns distinct industry values derived from the currently available roles catalog (DB when available, otherwise seed catalog). IMPORTANT: always returns a JSON array of strings (and returns [] with HTTP 200 on error).',
        responses: {
          200: {
            description: 'Industries list (array of strings)',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },

    '/api/roles/skills': {
      get: {
        tags: ['Roles'],
        summary: 'List distinct skills for role filtering',
        description:
          'Returns distinct skill values derived from the currently available roles catalog (DB when available, otherwise seed catalog). IMPORTANT: always returns a JSON array of strings (and returns [] with HTTP 200 on error).',
        responses: {
          200: {
            description: 'Skills list (array of strings)',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },

    '/api/roles/titles': {
      get: {
        tags: ['Roles'],
        summary: 'List distinct role titles for role filtering',
        description:
          'Canonical titles endpoint for the Explore UI. IMPORTANT: always returns a JSON array of strings (and returns [] with HTTP 200 on error).',
        responses: {
          200: {
            description: 'Role titles list (array of strings)',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },

    '/api/roles/job-titles': {
      get: {
        tags: ['Roles'],
        summary: 'List distinct job titles for role filtering (legacy envelope)',
        description:
          'Backward-compatible legacy endpoint. Returns an object envelope { jobTitles: string[] }. Prefer /api/roles/titles for the canonical array response.',
        responses: {
          200: {
            description: 'Job titles list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    jobTitles: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['jobTitles']
                }
              }
            }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/api/personas/target-role': {
      post: {
        tags: ['Roles'],
        summary: 'Persist target future role selection',
        description:
          'Validates that role_id exists in the roles catalog and persists it as the user’s target future role selection.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PersonaTargetRoleSelectRequest' } }
          }
        },
        responses: {
          201: {
            description: 'Selection persisted',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PersonaTargetRoleSelectResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          404: {
            description: 'Role not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      },
      get: {
        tags: ['Roles'],
        summary: 'Get latest persisted target role selection',
        description: 'Returns the latest saved target role selection for a given user_id.',
        parameters: [
          {
            name: 'user_id',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'User id (uuid).'
          }
        ],
        responses: {
          200: {
            description: 'Latest selection',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PersonaTargetRoleGetResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          503: {
            description: 'DB unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/api/mindmap/graph': {
      get: {
        tags: ['MindMap'],
        summary: 'Get mind map graph data (nodes/edges + per-node details)',
        description:
          'Returns mind map graph data for interactive visualization (zoom/pan) including per-node drill-down details. Supports filtering by salary range, skill similarity, and time horizon.',
        parameters: [
          {
            name: 'currentRoleTitle',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Current role title to display as the center node.'
          },
          {
            name: 'minSalaryLpa',
            in: 'query',
            required: false,
            schema: { type: 'number' },
            description: 'Minimum salary (LPA) filter.'
          },
          {
            name: 'maxSalaryLpa',
            in: 'query',
            required: false,
            schema: { type: 'number' },
            description: 'Maximum salary (LPA) filter.'
          },
          {
            name: 'minSkillSimilarity',
            in: 'query',
            required: false,
            schema: { type: 'number', minimum: 0, maximum: 100 },
            description: 'Minimum skill similarity score (0-100).'
          },
          {
            name: 'timeHorizon',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['Near', 'Mid', 'Far'] },
            description: 'Filter branches by time horizon.'
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 3, maximum: 100 },
            description: 'Maximum nodes to return (including center).'
          }
        ],
        responses: {
          200: {
            description: 'Mind map graph',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MindMapGraphResponse' } }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },

    '/api/mindmap/nodes/{id}': {
      get: {
        tags: ['MindMap'],
        summary: 'Get details payload for a mind map node',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Node id (role id) to fetch details for.'
          }
        ],
        responses: {
          200: {
            description: 'Node details',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MindMapNodeDetails' } }
            }
          },
          404: {
            description: 'Node not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          500: {
            description: 'Internal error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    }
  }
};

const options = {
  definition: openapiDefinition,
  // No annotation scanning required; keep deterministic and stable.
  apis: []
};

// PUBLIC_INTERFACE
export function getOpenApiSpec() {
  /** Returns the OpenAPI JSON document for this API. */
  return swaggerJSDoc(options);
}
