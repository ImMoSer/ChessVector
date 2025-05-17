// src/core/stockfish.service.ts
import logger from '../utils/logger';

// Интерфейс для опций анализа
export interface AnalysisOptions {
  depth?: number;       // Глубина анализа
  movetime?: number;    // Время на анализ в миллисекундах
  lines?: number;       // Количество линий для анализа (MultiPV)
}

// Интерфейс для информации об оценке
export interface ScoreInfo {
  type: 'cp' | 'mate'; // Тип оценки: сантипешки или мат
  value: number;       // Значение оценки
}

// Интерфейс для одной проанализированной линии
export interface EvaluatedLine {
  id: number;          // Номер линии (из MultiPV, обычно 1 для лучшей)
  depth: number;       // Глубина, достигнутая для этой линии
  score: ScoreInfo;
  pvUci: string[];     // Главный вариант (PV) как массив ходов в UCI нотации
}

// Интерфейс для результата анализа
export interface AnalysisResult {
  bestMoveUci: string | null; // Абсолютно лучший ход от Stockfish (первый ход основной линии)
  evaluatedLines: EvaluatedLine[];
}

// Типы для resolve/reject промиса анализа
type AnalysisResolve = (value: AnalysisResult | null) => void;
type AnalysisReject = (reason?: any) => void;

// Интерфейс для отслеживания текущего запроса на анализ
interface PendingAnalysisRequest {
  resolve: AnalysisResolve;
  reject: AnalysisReject;
  timeoutId: number;
  fen: string;
  options: AnalysisOptions;
  collectedLines: Map<number, EvaluatedLine>;
  currentBestMove: string | null;
}

export class StockfishService {
  private worker: Worker | null = null;
  private isReady: boolean = false;
  private commandQueue: string[] = [];
  private initPromise: Promise<void>;
  private resolveInitPromise!: () => void;
  private rejectInitPromise!: (reason?: any) => void;

  private pendingAnalysisRequest: PendingAnalysisRequest | null = null;

  constructor() {
    this.initPromise = new Promise<void>((resolve, reject) => {
      this.resolveInitPromise = resolve;
      this.rejectInitPromise = reject;
    });
    this.initWorker();
  }

  private initWorker(): void {
    if (this.worker) {
      this.terminate();
    }

    try {
      const wasmSupported = (() => {
        try {
          if (typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function") {
            const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
            if (module instanceof WebAssembly.Module)
              return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
          }
        } catch (e) { /* WASM not supported */ }
        return false;
      })();

      const workerFileName = wasmSupported ? 'stockfish.wasm.js' : 'stockfish.js';
      const workerPath = `/stockfish/${workerFileName}`;
      const absoluteWorkerPath = new URL(workerPath, window.location.origin).href;

      logger.info(`[StockfishService] WASM supported: ${wasmSupported}. Initializing worker with path: ${absoluteWorkerPath}`);
      this.worker = new Worker(absoluteWorkerPath, { type: 'classic' });

      this.worker.onmessage = (event: MessageEvent) => {
        this.handleEngineMessage(event.data as string);
      };

      this.worker.onerror = (errorEvent: Event | ErrorEvent) => {
        let errorMessage = 'Generic worker error';
        if (errorEvent instanceof ErrorEvent) {
            errorMessage = `Worker ErrorEvent: message='${errorEvent.message}', filename='${errorEvent.filename}', lineno=${errorEvent.lineno}, colno=${errorEvent.colno}`;
        }
        logger.error('[StockfishService] Worker error:', errorMessage, errorEvent);
        this.isReady = false;
        // Убедимся, что rejectInitPromise существует и является функцией перед вызовом
        if (this.rejectInitPromise && typeof this.rejectInitPromise === 'function') {
            try {
                this.rejectInitPromise(new Error(errorMessage));
            } catch(e) { /* Promise might already be settled */ }
        }
        if (this.pendingAnalysisRequest) {
          clearTimeout(this.pendingAnalysisRequest.timeoutId);
          try {
            this.pendingAnalysisRequest.reject(new Error('Worker error occurred during analysis request'));
          } catch(e) { /* Promise might already be settled */ }
          this.pendingAnalysisRequest = null;
        }
      };

      this.sendCommand('uci');

      setTimeout(() => {
        if (!this.isReady) {
            const errorMsg = 'UCI handshake timeout';
            logger.error(`[StockfishService] ${errorMsg}`);
            if (this.rejectInitPromise && typeof this.rejectInitPromise === 'function') {
                try {
                    this.rejectInitPromise(new Error(errorMsg));
                } catch(e) { /* Promise might already be settled */ }
            }
        }
      }, 15000);

    } catch (error: any) {
      logger.error('[StockfishService] Failed to initialize worker (constructor error):', error.message, error);
      this.isReady = false;
      if (this.rejectInitPromise && typeof this.rejectInitPromise === 'function') {
          try {
            this.rejectInitPromise(error);
          } catch(e) { /* Promise might already be settled */ }
      }
    }
  }

  private sendCommand(command: string): void {
    if (this.worker) {
      if (command !== 'uci' && command !== 'isready' && !this.isReady) {
        logger.debug(`[StockfishService] Engine not ready, queuing command: ${command}`);
        this.commandQueue.push(command);
        return;
      }
      logger.debug(`[StockfishService] Sending to Stockfish: ${command}`);
      this.worker.postMessage(command);
    } else {
      logger.warn('[StockfishService] Worker not initialized, cannot send command:', command);
    }
  }

  private processCommandQueue(): void {
    logger.debug(`[StockfishService] Processing command queue (${this.commandQueue.length} items)`);
    while(this.commandQueue.length > 0) {
        const command = this.commandQueue.shift();
        if (command) {
            if (this.isReady) {
                 this.sendCommand(command);
            } else {
                logger.warn(`[StockfishService] Engine not ready during queue processing, re-queuing: ${command}`);
                this.commandQueue.unshift(command);
                break;
            }
        }
    }
  }

  private handleEngineMessage(message: string): void {
    logger.debug(`[StockfishService] Received from Stockfish: ${message}`);
    const parts = message.split(' ');

    if (message === 'uciok') {
      logger.info('[StockfishService] UCI OK received.');
      this.sendCommand('isready');
    } else if (message === 'readyok') {
      this.isReady = true;
      logger.info('[StockfishService] Engine is ready (readyok received).');

      if (this.resolveInitPromise && typeof this.resolveInitPromise === 'function') {
        try {
            this.resolveInitPromise();
        } catch(e) { /* Promise might already be settled */ }
      }
      this.processCommandQueue();
    } else if (parts[0] === 'info' && this.pendingAnalysisRequest) {
      this.parseInfoLine(message, this.pendingAnalysisRequest.collectedLines);
    } else if (parts[0] === 'bestmove' && parts[1]) {
      if (this.pendingAnalysisRequest) {
        clearTimeout(this.pendingAnalysisRequest.timeoutId);
        const bestMoveUci = parts[1] === '(none)' ? null : parts[1];
        this.pendingAnalysisRequest.currentBestMove = bestMoveUci;

        const result: AnalysisResult = {
          bestMoveUci: this.pendingAnalysisRequest.currentBestMove,
          evaluatedLines: Array.from(this.pendingAnalysisRequest.collectedLines.values())
                              .sort((a, b) => a.id - b.id)
        };
        logger.info('[StockfishService] Analysis complete. Best move:', bestMoveUci, 'Lines:', result.evaluatedLines.length);
        try {
            this.pendingAnalysisRequest.resolve(result);
        } catch(e) { /* Promise might already be settled */ }
        this.pendingAnalysisRequest = null;
      } else {
        logger.warn('[StockfishService] Received bestmove but no pending analysis request.');
      }
    }
  }

  private parseInfoLine(line: string, collectedLines: Map<number, EvaluatedLine>): void {
    try {
      let currentLineId = 1;
      let depth = 0;
      let score: ScoreInfo | null = null;
      let pvUci: string[] = [];

      const parts = line.split(' ');
      let i = 0;
      while (i < parts.length) {
        const token = parts[i];
        switch (token) {
          case 'depth':
            depth = parseInt(parts[++i], 10);
            break;
          case 'multipv':
            currentLineId = parseInt(parts[++i], 10);
            break;
          case 'score':
            const type = parts[++i];
            const value = parseInt(parts[++i], 10);
            if (type === 'cp' || type === 'mate') {
              score = { type, value };
            }
            break;
          case 'pv':
            pvUci = parts.slice(i + 1);
            i = parts.length;
            break;
        }
        i++;
      }

      if (score && pvUci.length > 0 && !isNaN(depth) && depth > 0) { // Добавлена проверка на валидность depth
        const existingLine = collectedLines.get(currentLineId);
        // Обновляем линию, только если новая глубина больше или равна,
        // или если это первая информация для этой линии
        if (!existingLine || depth >= existingLine.depth) {
             collectedLines.set(currentLineId, { id: currentLineId, depth, score, pvUci });
        }
      }
    } catch (error) {
      logger.warn('[StockfishService] Error parsing info line:', line, error);
    }
  }

  public async ensureReady(): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }
    return this.initPromise;
  }

  public async getAnalysis(fen: string, options: AnalysisOptions = {}): Promise<AnalysisResult | null> {
    try {
      await this.ensureReady();
    } catch (error) {
      logger.error('[StockfishService] Engine failed to initialize for getAnalysis:', error);
      return null;
    }

    if (!this.worker) {
        logger.error('[StockfishService] Worker not available for getAnalysis.');
        return null;
    }

    if (this.pendingAnalysisRequest) {
        logger.warn('[StockfishService] Another analysis request is already pending. Rejecting new request.');
        return Promise.reject(new Error('Another analysis request is pending.'));
    }

    return new Promise<AnalysisResult | null>((resolve, reject) => {
      const lines = options.lines || 1;
      const baseTimeout = 5000; // 5 секунд базовый таймаут
      // Увеличиваем время расчета немного, если глубина большая или много линий
      const depthFactor = Math.max(1, (options.depth || 10) / 10);
      const linesFactor = lines > 1 ? 1.5 : 1;
      const calculationTime = options.movetime || (options.depth || 10) * 1000 * depthFactor * linesFactor;
      const timeoutDuration = baseTimeout + calculationTime;

      logger.debug(`[StockfishService] getAnalysis: FEN=${fen}, Options=${JSON.stringify(options)}, TimeoutDuration=${timeoutDuration}ms`);


      const timeoutId = window.setTimeout(() => {
        logger.warn(`[StockfishService] getAnalysis timeout for FEN: ${fen} after ${timeoutDuration}ms`);
        if (this.pendingAnalysisRequest && this.pendingAnalysisRequest.timeoutId === timeoutId) {
            // Попытка отправить 'stop' перед тем, как отклонить промис
            this.sendCommand('stop');
            try {
                this.pendingAnalysisRequest.reject(new Error('Stockfish getAnalysis timeout'));
            } catch(e) { /* Promise might already be settled */ }
            this.pendingAnalysisRequest = null;
        }
      }, timeoutDuration);

      this.pendingAnalysisRequest = {
        resolve,
        reject,
        timeoutId,
        fen,
        options,
        collectedLines: new Map<number, EvaluatedLine>(),
        currentBestMove: null,
      };

      this.sendCommand('ucinewgame');
      this.sendCommand(`setoption name MultiPV value ${lines}`);
      this.sendCommand(`position fen ${fen}`);

      let goCommand = 'go';
      if (options.depth) {
        goCommand += ` depth ${options.depth}`;
      }
      if (options.movetime) {
        goCommand += ` movetime ${options.movetime}`;
      }
      if (!options.depth && !options.movetime) {
        goCommand += ` depth 10`;
      }
      this.sendCommand(goCommand);
    });
  }

  public async getBestMoveOnly(fen: string, options: { depth?: number; movetime?: number } = {}): Promise<string | null> {
    const analysisOptions: AnalysisOptions = {
      ...options,
      lines: 1,
    };
    const result = await this.getAnalysis(fen, analysisOptions);
    return result ? result.bestMoveUci : null;
  }

  public terminate(): void {
    if (this.worker) {
      logger.info('[StockfishService] Terminating worker...');
      try {
        this.worker.postMessage('quit');
      } catch (e) {
        logger.warn('[StockfishService] Error sending "quit" command, worker might already be terminated.', e);
      }
      setTimeout(() => {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            logger.info('[StockfishService] Worker forcefully terminated.');
        }
      }, 500);

      this.isReady = false;
      this.commandQueue = [];
      if (this.rejectInitPromise && typeof this.rejectInitPromise === 'function') {
        try {
            this.rejectInitPromise(new Error('Worker terminated during initialization.'));
        } catch (e) { /* ignore if promise already settled */ }
      }
      this.initPromise = new Promise<void>((resolve, reject) => {
        this.resolveInitPromise = resolve;
        this.rejectInitPromise = reject;
      });

      if (this.pendingAnalysisRequest) {
          clearTimeout(this.pendingAnalysisRequest.timeoutId);
          try {
            this.pendingAnalysisRequest.reject(new Error('Worker terminated during analysis request'));
          } catch (e) { /* ignore if promise already settled */ }
          this.pendingAnalysisRequest = null;
      }
    }
  }
}
