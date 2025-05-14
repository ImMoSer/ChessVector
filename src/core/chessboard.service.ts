// src/core/chessboard.service.ts
import { Chessground } from 'chessground';
import type { Api, Key, Dests, Config } from 'chessground';
import logger from '../utils/logger';

export class ChessboardService {
  public ground: Api | null = null; // Сделаем явно public для временного решения

  public init(element: HTMLElement, config?: Config): Api | null {
    if (this.ground) {
      logger.warn('Chessground already initialized.');
      return this.ground;
    }

    const defaultConfig: Config = {
      orientation: 'white',
    };

    const finalConfig = { ...defaultConfig, ...config };

    try {
      this.ground = Chessground(element, finalConfig);
      logger.info('Chessground initialized');
      return this.ground;
    } catch (error) {
      logger.error('Failed to initialize Chessground:', error);
      return null;
    }
  }

  public getFen(): string | undefined {
    return this.ground?.getFen();
  }

  public setFen(fen: string): void {
    this.ground?.set({ fen });
  }

  public move(orig: Key, dest: Key, _promotion?: string): void {
    logger.warn(`Programmatic move from ${orig} to ${dest} - implement logic if needed.`);
  }

  public setOrientation(color: 'white' | 'black'): void {
    this.ground?.set({ orientation: color });
  }

  public drawShapes(shapes: Array<{ orig: Key, dest?: Key, brush: string }>): void {
    this.ground?.setShapes(shapes.map(s => ({
        orig: s.orig,
        dest: s.dest,
        brush: s.brush
    })));
  }

  public clearShapes(): void {
    this.ground?.setShapes([]);
  }

  public destroy(): void {
    if (this.ground) {
      this.ground.destroy();
      this.ground = null;
      logger.info('Chessground destroyed');
    }
  }

  public getDests(): Dests | undefined {
    return this.ground?.state.movable.dests;
  }

  public setDests(dests: Dests): void {
    this.ground?.set({ movable: { dests } });
  }
}
