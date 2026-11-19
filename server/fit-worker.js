// Runs one fit off the server's main thread, as the optimizer blocks the thread it runs on.
// Receives `fitWeights`'s input as workerData and posts back its result, or `{ error }`.

import { parentPort, workerData } from 'node:worker_threads';
import { fitWeights } from './fit-model.js';

try {
  parentPort.postMessage({ result: await fitWeights(workerData) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
