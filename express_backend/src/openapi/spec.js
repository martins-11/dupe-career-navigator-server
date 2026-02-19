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

const swaggerJSDoc = require('swagger-jsdoc');

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
    { name: 'Documents', description: 'Document metadata and extracted text persistence.' },
    { name: 'Uploads', description: 'Multi-file upload endpoints (placeholder; no persistence yet).' },
    { name: 'Extraction', description: 'PDF/TXT text extraction and text normalization (placeholders).' },
    { name: 'Personas', description: 'Persona CRUD and version history.' }
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
          uploadId: { type: 'string', format: 'uuid', description: 'Server-generated placeholder upload batch id.' },
          receivedFiles: {
            type: 'array',
            items: { $ref: '#/components/schemas/UploadFileResult' },
            description: 'Files accepted by multer (stored in memory only for this scaffold).'
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
          'Placeholder multi-file upload endpoint using multipart/form-data. Files are accepted into memory and metadata is returned; no DB/storage persistence is performed in this scaffold.',
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
                    description: 'One or more files.'
                  },
                  userId: { type: 'string', format: 'uuid', nullable: true, description: 'Optional user id.' },
                  source: { type: 'string', nullable: true, description: 'Optional source label (e.g., resume, linkedin).' }
                },
                required: ['files']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Upload accepted (placeholder)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MultiFileUploadResponse' } }
            }
          },
          400: {
            description: 'Validation error (e.g., missing files)',
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
          'Placeholder multi-file upload endpoint for text inputs. Uses multipart/form-data and returns received file metadata only.',
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
                    description: 'One or more text files.'
                  },
                  userId: { type: 'string', format: 'uuid', nullable: true }
                },
                required: ['files']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Upload accepted (placeholder)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MultiFileUploadResponse' } }
            }
          },
          400: {
            description: 'Validation error (e.g., missing files)',
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

    '/documents': {
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
    }
  }
};

const options = {
  definition: openapiDefinition,
  // No annotation scanning required; keep deterministic and stable.
  apis: []
};

// PUBLIC_INTERFACE
function getOpenApiSpec() {
  /** Returns the OpenAPI JSON document for this API. */
  return swaggerJSDoc(options);
}

module.exports = { getOpenApiSpec };
