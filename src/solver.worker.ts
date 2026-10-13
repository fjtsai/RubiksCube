import Cube from "cubejs";
import "cubejs/lib/solve";
import { parseAlgorithm } from "./domain/moves";

type WorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "solve"; algorithm: string }
  | { id: number; type: "solveFacelets"; facelets: string };

type WorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "solution"; moves: string[]; raw: string }
  | { id: number; type: "error"; message: string };

let initialized = false;

function ensureSolverReady(): void {
  if (initialized) return;
  Cube.initSolver();
  initialized = true;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    ensureSolverReady();

    if (request.type === "init") {
      post({ id: request.id, type: "ready" });
      return;
    }

    const cube = request.type === "solveFacelets" ? Cube.fromString(request.facelets) : new Cube();
    if (request.type === "solve" && request.algorithm.trim()) {
      cube.move(request.algorithm);
    }

    const raw = cube.solve();
    post({
      id: request.id,
      type: "solution",
      raw,
      moves: parseAlgorithm(raw),
    });
  } catch (error) {
    post({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : "Solver failed",
    });
  }
};
