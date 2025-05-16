// src/core/chessboard.service.ts

import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type {
  Key,
  Dests,
  Color, // Color используется для piece и ориентации
  FEN,
  // Pieces, // Не используется напрямую в этом файле
} from 'chessground/types';
// Импортируем типы, которые могут быть частью DrawShape
import type { DrawModifiers, DrawShapePiece } from 'chessground/draw';
import type { Role as ChessopsRole } from 'chessops/types'; // Для типа роли в setPieceAt
import logger from '../utils/logger';

// Экспортируемый интерфейс CustomDrawShape
// Он наследует все поля от DrawShape из chessground/draw,
// но делает 'brush' обязательным строковым свойством.
export interface CustomDrawShape {
  orig: Key;
  dest?: Key;
  brush: string; // brush теперь обязательный string
  modifiers?: DrawModifiers;
  piece?: DrawShapePiece;
  customSvg?: {
    html: string;
    center?: 'orig' | 'dest' | 'label';
  };
  label?: {
    text: string;
    fill?: string;
  };
  // Можно добавить и другие свойства из DrawShape, если они понадобятся
}


export class ChessboardService {
  public ground: Api | null = null;

  public init(element: HTMLElement, config?: Config): Api | null {
    if (this.ground) {
      logger.warn('Chessground already initialized.');
      return this.ground;
    }
    const defaultConfig: Config = {
      orientation: 'white', // Значение по умолчанию для ориентации
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
    return this.ground?.getFen(); // Возвращает только часть FEN с расстановкой фигур
  }

  /**
   * Устанавливает позицию на доске по части FEN, отвечающей за расстановку фигур.
   * @param fenPiecePlacement - Строка FEN, содержащая только расстановку фигур (например, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR").
   */
  public setFen(fenPiecePlacement: string): void {
    if (this.ground) {
      this.ground.set({ fen: fenPiecePlacement });
      // logger.debug(`[ChessboardService] FEN piece placement set to: ${fenPiecePlacement}`);
    }
  }

  /**
   * Устанавливает или удаляет фигуру на указанной клетке.
   * @param key - Клетка (например, 'e4').
   * @param piece - Объект с фигурой { role: ChessopsRole, color: Color } или null для удаления фигуры.
   */
  public setPieceAt(key: Key, piece: { role: ChessopsRole; color: Color } | null): void {
    if (this.ground) {
      const currentPieces = new Map(this.ground.state.pieces);
      if (piece) {
        // Chessground ожидает Role из своих типов, но ChessopsRole должен быть совместим.
        // promoted: true важно для корректного отображения, если фигура была пешкой, ставшей другой фигурой.
        currentPieces.set(key, { ...piece, promoted: piece.role !== 'pawn' });
      } else {
        currentPieces.delete(key);
      }
      this.ground.setPieces(currentPieces);
      logger.debug(`[ChessboardService] Piece at ${key} set to:`, piece);
    }
  }


  public move(orig: Key, dest: Key, _promotion?: string): void {
    logger.warn(`Programmatic move from ${orig} to ${dest} - implement logic if needed.`);
    // Для программного хода с промоушеном, Chessground ожидает ход в формате UCI,
    // например, ground.move('e7e8', 'q') или ground.playUci('e7e8q')
    // Если вы будете использовать этот метод, убедитесь, что он правильно обрабатывает промоушен.
  }

  public setOrientation(color: Color): void {
    this.ground?.set({ orientation: color });
  }

  /**
   * Рисует пользовательские фигуры (стрелки, круги) на доске.
   * @param shapes Массив объектов CustomDrawShape.
   */
  public drawShapes(shapes: Array<CustomDrawShape>): void {
    // Chessground.Api.setShapes ожидает массив объектов, совместимых с DrawShape из chessground/draw.
    // CustomDrawShape должен быть совместим с DrawShape, но с обязательным свойством brush.
    this.ground?.setShapes(shapes.map(s => ({
        orig: s.orig,
        dest: s.dest,
        brush: s.brush,
        // Передаем остальные опциональные свойства, если они есть в CustomDrawShape
        ...(s.modifiers && { modifiers: s.modifiers }),
        ...(s.piece && { piece: s.piece }),
        ...(s.customSvg && { customSvg: s.customSvg }),
        ...(s.label && { label: s.label }),
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
    const state = this.ground?.state;
    return state?.movable?.dests;
  }

  public setDests(dests: Dests): void {
    const currentMovable = this.ground?.state?.movable;
    this.ground?.set({
      movable: {
        ...(currentMovable || {}), // Сохраняем существующие настройки movable
        dests: dests
      }
    });
  }
}
