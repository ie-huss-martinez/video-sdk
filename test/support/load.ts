/**
 * How long a worker may take to start in these tests. Vite's dev server
 * serves the test workers as module graphs, hundreds of modules each, which
 * a heavily loaded machine fetches slowly. The packaged worker is one file:
 * it started in 0.1 to 0.5 s at a load average of about 25 on 12 cores,
 * well within sdk-core's 10 s default, which the SDK keeps.
 */
export const DEV_WORKER_START_TIMEOUT = 60_000;
