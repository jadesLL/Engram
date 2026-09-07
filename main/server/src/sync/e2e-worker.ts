import { workerData } from 'node:worker_threads';

/**
 * 多端同步 E2E 测试的实例入口：在 worker_threads 中运行一个完整的 Engram server。
 * 每个线程拥有独立模块注册表，各自打开自己的 DATA_DIR（与多进程等价）。
 * 仅由 sync.e2e.test.ts 使用：workerData 来自测试父线程的临时目录与空闲端口。
 */
const { dataDir, port } = workerData as { dataDir: string; port: number };
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.HOST = '127.0.0.1';

await import('../index.js');
