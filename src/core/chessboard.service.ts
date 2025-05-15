// src/core/chessboard.service.ts

// Импортируем основную функцию/класс Chessground
import { Chessground } from 'chessground';

// Импортируем типы из их предполагаемых подмодулей в библиотеке chessground
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
// Типы State и Movable не экспортируются отдельно, они являются частью Api и Config
import type {
  Key,
  Dests,
  Color,
  Role, // Импортируем Role, если он нужен для Piece-подобных структур
  FEN,
  Pieces,
  // Events, // Если используется в Config
  // Shape as CgShape, // Переименовываем, чтобы не конфликтовать с возможным вашим типом Shape
  // MoveMetadata // Если используется
} from 'chessground/types';

// Импортируем ваш логгер
import logger from '../utils/logger';

// Определяем тип для отрисовки фигур (shapes)
// (но лучше использовать DrawShape из 'chessground/types', если он подходит и импортирован как CgShape)
interface CustomDrawShape {
  orig: Key;
  dest?: Key;
  brush: string;
}


export class ChessboardService {
  public ground: Api | null = null;

  public init(element: HTMLElement, config?: Config): Api | null {
    if (this.ground) {
      logger.warn('Chessground already initialized.');
      return this.ground;
    }

    const defaultConfig: Config = {
      orientation: 'white',
      // movable здесь будет соответствовать структуре, определенной в Config
    };

    const finalConfig: Config = { ...defaultConfig, ...config };

    try {
      this.ground = Chessground(element, finalConfig);
      logger.info('Chessground initialized');
      return this.ground;
    } catch (error) {
      logger.error('Failed to initialize Chessground:', error);
      return null;
    }
  }

  public getFen(): FEN | undefined {
    return this.ground?.getFen();
  }

  public setFen(fen: FEN): void {
    this.ground?.set({ fen });
  }

  public move(orig: Key, dest: Key, _promotion?: string): void {
    logger.warn(`Programmatic move from ${orig} to ${dest} - implement logic if needed.`);
  }

  public setOrientation(color: Color): void {
    this.ground?.set({ orientation: color });
  }

  public drawShapes(shapes: Array<CustomDrawShape>): void {
    // Тип для элемента массива shapes должен соответствовать ожиданиям setShapes в Api.
    // В 'chessground/src/api.ts' setShapes ожидает DrawShape[]
    // DrawShape импортируется из './draw.js' в api.ts, но не реэкспортируется.
    // Однако, в 'chessground/src/config.ts' Config.drawable.shapes использует DrawShape.
    // И в 'chessground/src/draw.d.ts' есть экспорт: export type DrawShape = Circle | Arrow | PieceDestination;
    // Попробуем импортировать DrawShape из 'chessground/draw' если 'chessground/types' не сработает.
    // Пока оставим CustomDrawShape, но это место для потенциального улучшения, если найти экспорт DrawShape.
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
    // Тип this.ground.state будет выведен из Api.state
    const state = this.ground?.state;
    // Тип state.movable будет выведен из определения State.movable
    // (где State - это тип для Api.state)
    return state?.movable?.dests;
  }

  public setDests(dests: Dests): void {
    const currentMovable = this.ground?.state?.movable;
    // Объект, передаваемый в movable, будет структурно проверен
    // на соответствие типу Config.movable
    this.ground?.set({
      movable: {
        ...(currentMovable || {}), // Распространяем текущие свойства movable, если они есть
        dests: dests
      }
    });
  }
}
