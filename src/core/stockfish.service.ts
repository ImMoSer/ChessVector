// src/core/stockfish.service.ts
import logger from '../utils/logger';

interface GetBestMoveOptions {
  depth?: number;
  movetime?: number;
}

type BestMoveResolve = (value: string | null) => void;
type BestMoveReject = (reason?: any) => void;

interface PendingRequest {
  resolve: BestMoveResolve;
  reject: BestMoveReject;
  timeoutId: number;
}

export class StockfishService {
  private worker: Worker | null = null;
  private isReady: boolean = false;
  private commandQueue: string[] = [];
  private initPromise: Promise<void>;
  private resolveInitPromise!: () => void;
  private rejectInitPromise!: (reason?: any) => void;
  private pendingBestMoveRequest: PendingRequest | null = null;

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
      // Проверка поддержки WebAssembly
      const wasmSupported = (() => {
        try {
          if (typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function") {
            const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
            if (module instanceof WebAssembly.Module)
              return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
          }
        } catch (e) {
          // Ошибка при проверке, считаем что WASM не поддерживается
        }
        return false;
      })();

      const workerFileName = wasmSupported ? 'stockfish.wasm.js' : 'stockfish.js';
      // Файлы должны быть в public/stockfish/
      const workerPath = `/stockfish/${workerFileName}`; 
      
      const absoluteWorkerPath = new URL(workerPath, window.location.origin).href;
      logger.info(`[StockfishService] WASM supported: ${wasmSupported}. Initializing worker with resolved path: ${absoluteWorkerPath}`);
      
      this.worker = new Worker(absoluteWorkerPath, { type: 'classic' }); 

      this.worker.onmessage = (event: MessageEvent) => {
        this.handleEngineMessage(event.data as string);
      };

      this.worker.onerror = (errorEvent: Event | ErrorEvent) => {
        let errorMessage = 'Generic worker error';
        let errorObject: any = errorEvent;

        if (errorEvent instanceof ErrorEvent) {
            errorMessage = `Worker ErrorEvent: message='${errorEvent.message}', filename='${errorEvent.filename}', lineno=${errorEvent.lineno}, colno=${errorEvent.colno}`;
            errorObject = {
                message: errorEvent.message,
                filename: errorEvent.filename,
                lineno: errorEvent.lineno,
                colno: errorEvent.colno,
                error: errorEvent.error 
            };
        } else if (errorEvent instanceof Event) {
            errorMessage = `Worker Event (type: ${errorEvent.type})`;
        }
        logger.error('[StockfishService] Worker error:', errorMessage, errorObject);
        this.isReady = false;
        this.rejectInitPromise(new Error(errorMessage)); 
        if (this.pendingBestMoveRequest) {
          clearTimeout(this.pendingBestMoveRequest.timeoutId);
          this.pendingBestMoveRequest.reject(new Error('Worker error occurred during request'));
          this.pendingBestMoveRequest = null;
        }
      };
      
      this.sendCommand('uci');

      setTimeout(() => {
        if (!this.isReady) {
            const errorMsg = 'UCI handshake timeout';
            logger.error(`[StockfishService] ${errorMsg}`);
            this.rejectInitPromise(new Error(errorMsg));
        }
      }, 15000); // 15 секунд на UCI handshake

    } catch (error: any) {
      logger.error('[StockfishService] Failed to initialize worker (constructor error):', error.message, error);
      this.isReady = false;
      this.rejectInitPromise(error);
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
            this.sendCommand(command);
        }
    }
  }

  private handleEngineMessage(message: string): void {
    logger.debug(`[StockfishService] Received from Stockfish: ${message}`);
    const parts = message.split(' ');

    if (message === 'uciok') {
      // После uciok можно установить некоторые базовые опции, как в вашем примере
      // this.sendCommand('setoption name UCI_AnalyseMode value true'); // Если нужно для анализа
      // this.sendCommand('setoption name Contempt value 0'); // 'Analysis Contempt' в вашем примере был 'Off'
      this.sendCommand('isready');
    } else if (message === 'readyok') {
      this.isReady = true;
      logger.info('[StockfishService] Engine is ready (readyok received).');
      this.resolveInitPromise();
      this.processCommandQueue();
    } else if (parts[0] === 'bestmove' && parts[1]) {
      if (this.pendingBestMoveRequest) {
        const bestMoveUci = parts[1];
        // Дополнительная проверка, если Stockfish вернул "(none)" (например, при мате/пате)
        if (bestMoveUci === '(none)') {
            logger.info('[StockfishService] Best move is (none), resolving with null.');
            this.pendingBestMoveRequest.resolve(null);
        } else {
            logger.info(`[StockfishService] Best move received: ${bestMoveUci}`);
            this.pendingBestMoveRequest.resolve(bestMoveUci);
        }
        clearTimeout(this.pendingBestMoveRequest.timeoutId);
        this.pendingBestMoveRequest = null;
      } else {
        logger.warn('[StockfishService] Received bestmove but no pending request.');
      }
    }
    // TODO: В будущем здесь будет парсинг 'info' для непрерывного анализа
  }

  public async ensureReady(): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }
    return this.initPromise;
  }

  public async getBestMove(fen: string, options: GetBestMoveOptions = {}): Promise<string | null> {
    try {
      await this.ensureReady();
    } catch (error) {
      logger.error('[StockfishService] Engine failed to initialize for getBestMove:', error);
      return null;
    }

    if (!this.worker) {
        logger.error('[StockfishService] Worker not available for getBestMove.');
        return null;
    }
    
    if (this.pendingBestMoveRequest) {
        logger.warn('[StockfishService] Another best move request is already pending. Rejecting new request.');
        return Promise.reject(new Error('Another best move request is pending.'));
    }

    return new Promise<string | null>((resolve, reject) => {
      // Устанавливаем более реалистичные таймауты
      const baseTimeout = 5000; // 5 секунд базовый таймаут
      const calculationTime = options.movetime || (options.depth || 10) * 1000; // Примерное время на расчет
      const timeoutDuration = baseTimeout + calculationTime;
      
      const timeoutId = window.setTimeout(() => {
        logger.warn(`[StockfishService] getBestMove timeout for FEN: ${fen} after ${timeoutDuration}ms`);
        if (this.pendingBestMoveRequest && this.pendingBestMoveRequest.timeoutId === timeoutId) {
            this.pendingBestMoveRequest.reject(new Error('Stockfish getBestMove timeout'));
            this.pendingBestMoveRequest = null;
            this.sendCommand('stop'); 
        }
      }, timeoutDuration);

      this.pendingBestMoveRequest = { resolve, reject, timeoutId };

      this.sendCommand('ucinewgame'); // Важно для сброса состояния перед новым расчетом
      this.sendCommand(`position fen ${fen}`);
      
      let goCommand = 'go';
      if (options.depth) {
        goCommand += ` depth ${options.depth}`;
      } else if (options.movetime) {
        goCommand += ` movetime ${options.movetime}`;
      } else {
        // Значение по умолчанию, если ничего не указано
        // Для плей-аута может быть достаточно небольшой глубины или времени
        goCommand += ` depth 10`; 
      }
      this.sendCommand(goCommand);
    });
  }
  
  public terminate(): void {
    if (this.worker) {
      logger.info('[StockfishService] Terminating worker...');
      this.worker.postMessage('quit'); 
      setTimeout(() => {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            logger.info('[StockfishService] Worker forcefully terminated.');
        }
      }, 500); // Даем время на команду quit
      
      this.isReady = false;
      this.commandQueue = [];
      // Сбрасываем и отклоняем initPromise, если он еще не разрешен
      if (this.rejectInitPromise) {
        this.rejectInitPromise(new Error('Worker terminated during initialization.'));
      }
      this.initPromise = new Promise<void>((resolve, reject) => { // Пересоздаем для возможной реинициализации
        this.resolveInitPromise = resolve;
        this.rejectInitPromise = reject;
      });

      if (this.pendingBestMoveRequest) {
          clearTimeout(this.pendingBestMoveRequest.timeoutId);
          this.pendingBestMoveRequest.reject(new Error('Worker terminated during best move request'));
          this.pendingBestMoveRequest = null;
      }
    }
  }

  // Заглушки для будущих методов анализа (Фаза 2)
  // public startContinuousAnalysis(fen: string, onUpdate: (data: any) => void, options: any = {}): void {
  //   logger.info(`[StockfishService] TODO: Start continuous analysis for FEN: ${fen}`);
  // }

  // public stopAnalysis(): void {
  //   logger.info("[StockfishService] TODO: Stop continuous analysis");
  //   // this.sendCommand('stop');
  // }
  
  // public updateAnalysisPosition(fen: string): void {
  //    logger.info(`[StockfishService] TODO: Update analysis position to FEN: ${fen}`);
  //    // this.sendCommand('stop');
  //    // this.sendCommand(`position fen ${fen}`);
  //    // this.sendCommand('go infinite'); 
  // }

  // public setOption(name: string, value: string | number): void {
  //   logger.info(`[StockfishService] TODO: Set option ${name} to ${value}`);
  //   // this.sendCommand(`setoption name ${name} value ${value}`);
  // }
}
