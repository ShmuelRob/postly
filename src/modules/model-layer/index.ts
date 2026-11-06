// Model layer: task routing, prompt versions, schema validation, cost tracking, and logging.
// Public surface of the module: other code imports only from this file (see ../README.md).

export {
  createModelLayer,
  ModelTaskFailedError,
  type MediaUrlResolver,
  type ModelLayer,
  type ModelLayerDeps,
  type RunOptions,
} from './model-layer.js';

// The Vertex AI adapter, for the composition (agent.md, Running on dev).
export { adcTransport, type MediaFetcher, realModelsRefused, VertexModelProvider, type VertexRequestBody, type VertexResponseBody, type VertexTransport } from './adapters/vertex.js';
