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
  bestMoveUci: string | null; 
  evaluatedLines: EvaluatedLine[];
}

type AnalysisResolve = (value: AnalysisResult | null) => void;
type AnalysisReject = (reason?: any) => void;

interface PendingAnalysisRequest {
  resolve: AnalysisResolve;
  reject: AnalysisReject;
  timeoutId: number;
  fen: string;
  options: AnalysisOptions;
  collectedLines: Map<number, EvaluatedLine>;
  currentBestMove: string | null;
  isActive: boolean; // Флаг, чтобы пометить запрос как отмененный/перекрытый
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
        if (this.rejectInitPromise && typeof this.rejectInitPromise === 'function') {
            try { this.rejectInitPromise(new Error(errorMessage)); } catch(e) { /* Promise might already be settled */ }
        }
        if (this.pendingAnalysisRequest) {
          if (this.pendingAnalysisRequest.isActive) { // Отклоняем только если он все еще считается активным
            clearTimeout(this.pendingAnalysisRequest.timeoutId);
            try { this.pendingAnalysisRequest.reject(new Error('Worker error occurred during analysis request')); } catch(e) { /* Promise might already be settled */ }
          }
          this.pendingAnalysisRequest = null;
        }
      };

      this.sendCommand('uci');

      setTimeout(() => {
        if (!this.isReady) {
            const errorMsg = 'UCI handshake timeout';
            logger.error(`[StockfishService] ${errorMsg}`);
            if (this.rejectInitPromise && typeof this.rejectInitPromise === 'function') {
                try { this.rejectInitPromise(new Error(errorMsg)); } catch(e) { /* Promise might already be settled */ }
            }
        }
      }, 15000);

    } catch (error: any) {
      logger.error('[StockfishService] Failed to initialize worker (constructor error):', error.message, error);
      this.isReady = false;
      if (this.rejectInitPromise && typeof this.rejectInitPromise === 'function') {
          try { this.rejectInitPromise(error); } catch(e) { /* Promise might already be settled */ }
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
        try { this.resolveInitPromise(); } catch(e) { /* Promise might already be settled */ }
      }
      this.processCommandQueue();
    } else if (parts[0] === 'info' && this.pendingAnalysisRequest && this.pendingAnalysisRequest.isActive) {
      this.parseInfoLine(message, this.pendingAnalysisRequest.collectedLines);
    } else if (parts[0] === 'bestmove') { // Removed parts[1] check, as 'bestmove (none)' is valid
      if (this.pendingAnalysisRequest) {
        if (this.pendingAnalysisRequest.isActive) { // Только если запрос не был отменен/перекрыт
            clearTimeout(this.pendingAnalysisRequest.timeoutId);
            const bestMoveUci = (parts[1] && parts[1] !== '(none)') ? parts[1] : null;
            this.pendingAnalysisRequest.currentBestMove = bestMoveUci;

            const result: AnalysisResult = {
              bestMoveUci: this.pendingAnalysisRequest.currentBestMove,
              evaluatedLines: Array.from(this.pendingAnalysisRequest.collectedLines.values())
                                  .sort((a, b) => a.id - b.id)
            };
            logger.info('[StockfishService] Analysis complete. Best move:', bestMoveUci, 'Lines:', result.evaluatedLines.length);
            try { this.pendingAnalysisRequest.resolve(result); } catch(e) { /* Promise might already be settled */ }
        } else {
            logger.info('[StockfishService] Received bestmove for a superseded/cancelled request. Ignoring.');
        }
        this.pendingAnalysisRequest = null; // Запрос обработан или был неактивен
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
          case 'depth': depth = parseInt(parts[++i], 10); break;
          case 'multipv': currentLineId = parseInt(parts[++i], 10); break;
          case 'score':
            const type = parts[++i];
            const value = parseInt(parts[++i], 10);
            if (type === 'cp' || type === 'mate') score = { type, value };
            break;
          case 'pv': pvUci = parts.slice(i + 1); i = parts.length; break;
        }
        i++;
      }
      if (score && pvUci.length > 0 && !isNaN(depth) && depth > 0) {
        const existingLine = collectedLines.get(currentLineId);
        if (!existingLine || depth >= existingLine.depth) {
             collectedLines.set(currentLineId, { id: currentLineId, depth, score, pvUci });
        }
      }
    } catch (error) {
      logger.warn('[StockfishService] Error parsing info line:', line, error);
    }
  }

  public async ensureReady(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    return this.initPromise;
  }

  public async getAnalysis(fen: string, options: AnalysisOptions = {}): Promise<AnalysisResult | null> {
    try {
      await this.ensureReady();
    } catch (error) {
      logger.error('[StockfishService] Engine failed to initialize for getAnalysis:', error);
      return Promise.reject(error); // Отклоняем промис, если движок не готов
    }

    if (!this.worker) {
        const workerError = new Error('Worker not available for getAnalysis.');
        logger.error(`[StockfishService] ${workerError.message}`);
        return Promise.reject(workerError);
    }

    if (this.pendingAnalysisRequest) {
        logger.warn('[StockfishService] New analysis request received while previous one is pending. Superseding previous request.');
        if (this.pendingAnalysisRequest.isActive) {
            this.pendingAnalysisRequest.isActive = false; // Помечаем старый запрос как неактивный
            clearTimeout(this.pendingAnalysisRequest.timeoutId);
            try {
                this.pendingAnalysisRequest.reject(new Error('Analysis request superseded by a new one.'));
            } catch (e) { /* Старый промис мог уже быть урегулирован (например, по таймауту) */ }
        }
        this.sendCommand('stop'); // Останавливаем текущие вычисления движка
        // this.pendingAnalysisRequest = null; // Не сбрасываем здесь, он будет перезаписан
    }

    return new Promise<AnalysisResult | null>((resolve, reject) => {
      const lines = options.lines || 1;
      const baseTimeout = 5000; 
      const depthFactor = Math.max(1, (options.depth || 10) / 10);
      const linesFactor = lines > 1 ? 1.5 : 1;
      const calculationTime = options.movetime || (options.depth || 10) * 1000 * depthFactor * linesFactor;
      const timeoutDuration = baseTimeout + calculationTime;

      logger.debug(`[StockfishService] getAnalysis: FEN=${fen}, Options=${JSON.stringify(options)}, TimeoutDuration=${timeoutDuration}ms`);

      const currentRequestObject: PendingAnalysisRequest = { // Создаем объект запроса сразу
        resolve,
        reject,
        timeoutId: 0, // Будет установлен ниже
        fen,
        options,
        collectedLines: new Map<number, EvaluatedLine>(),
        currentBestMove: null,
        isActive: true, // Новый запрос всегда активен
      };

      currentRequestObject.timeoutId = window.setTimeout(() => {
        if (this.pendingAnalysisRequest === currentRequestObject && currentRequestObject.isActive) { // Проверяем, что это таймаут для текущего активного запроса
            logger.warn(`[StockfishService] getAnalysis timeout for FEN: ${fen} after ${timeoutDuration}ms`);
            this.sendCommand('stop');
            currentRequestObject.isActive = false; // Помечаем как неактивный из-за таймаута
            try {
                reject(new Error('Stockfish getAnalysis timeout'));
            } catch(e) { /* Промис мог быть уже урегулирован */ }
            if (this.pendingAnalysisRequest === currentRequestObject) {
                this.pendingAnalysisRequest = null;
            }
        }
      }, timeoutDuration);

      this.pendingAnalysisRequest = currentRequestObject;

      this.sendCommand('ucinewgame'); // Всегда начинаем с новой игры для чистоты состояния
      this.sendCommand(`setoption name MultiPV value ${lines}`);
      this.sendCommand(`position fen ${fen}`);

      let goCommand = 'go';
      if (options.depth) goCommand += ` depth ${options.depth}`;
      if (options.movetime) goCommand += ` movetime ${options.movetime}`;
      if (!options.depth && !options.movetime) goCommand += ` depth 10`; // Дефолтная глубина, если ничего не указано
      
      this.sendCommand(goCommand);
    });
  }

  public async getBestMoveOnly(fen: string, options: { depth?: number; movetime?: number } = {}): Promise<string | null> {
    const analysisOptions: AnalysisOptions = {
      ...options,
      lines: 1,
    };
    try {
        const result = await this.getAnalysis(fen, analysisOptions);
        return result ? result.bestMoveUci : null;
    } catch (error) {
        // Если getAnalysis был отклонен (например, из-за ошибки инициализации или перекрытия запроса),
        // то getBestMoveOnly также должен вернуть null или перебросить ошибку.
        // Для простоты возвращаем null.
        logger.warn(`[StockfishService getBestMoveOnly] Underlying getAnalysis failed: ${(error as Error).message}`);
        return null;
    }
  }

  public terminate(): void {
    if (this.worker) {
      logger.info('[StockfishService] Terminating worker...');
      try { this.worker.postMessage('quit'); } catch (e) { /* ... */ }
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
        try { this.rejectInitPromise(new Error('Worker terminated during initialization.')); } catch (e) { /* ... */ }
      }
      this.initPromise = new Promise<void>((resolve, reject) => {
        this.resolveInitPromise = resolve;
        this.rejectInitPromise = reject;
      });

      if (this.pendingAnalysisRequest) {
          if (this.pendingAnalysisRequest.isActive) {
            clearTimeout(this.pendingAnalysisRequest.timeoutId);
            try { this.pendingAnalysisRequest.reject(new Error('Worker terminated during analysis request')); } catch (e) { /* ... */ }
          }
          this.pendingAnalysisRequest = null;
      }
    }
  }
}
