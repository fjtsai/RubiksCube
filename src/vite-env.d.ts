/// <reference types="vite/client" />

declare module "cubejs" {
  export default class Cube {
    constructor(state?: unknown);
    static initSolver(): void;
    static fromString(state: string): Cube;
    static random(): Cube;
    static scramble(): string;
    clone(): Cube;
    move(algorithm: string): Cube;
    solve(): string;
    asString(): string;
    toJSON(): unknown;
  }
}

declare module "cubejs/lib/solve" {
  const value: unknown;
  export default value;
}
