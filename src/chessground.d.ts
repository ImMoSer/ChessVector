// src/types/chessground.d.ts

declare module 'chessground' {
  export interface Api {
    set(config: Config): void;
    getFen(): string;
    getOrientation(): Color;
    toggleOrientation(): void;
    destroy(): void;
    setShapes(shapes: Shape[]): void;
    playPremove(): boolean;
    playPredrop(role: Role, key: Key): boolean;
    cancelPremove(): void;
    cancelPredrop(): void;
    setPieces(pieces: Pieces): void;
    setCheck(color?: Color): void;
    state: State;
    move(orig: Key, dest: Key): void;
    newPiece(piece: Piece, key: Key): void;
  }

  export interface Config {
    orientation?: Color;
    fen?: FEN;
    lastMove?: Key[];
    check?: boolean | Key;
    turnColor?: Color;
    movable?: Movable;
    premovable?: Premoveable;
    predroppable?: Predroppable;
    draggable?: Draggable;
    selectable?: Selectable;
    highlight?: Highlight;
    animation?: Animation;
    events?: Events;
    viewOnly?: boolean;
    disableContextMenu?: boolean;
    addPieceZIndex?: boolean;
    blockTouchScroll?: boolean;
    pieces?: Pieces;
    drawable?: Drawable;
    autoCastle?: boolean;
  }

  export type Key = string;
  export type FEN = string;
  export type Color = 'white' | 'black';
  export type Role = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king';

  export interface Piece {
    role: Role;
    color: Color;
    promoted?: boolean;
  }

  export type Pieces = Map<Key, Piece>;

  export interface Dests extends Map<Key, Key[]> {
    [key: string]: Key[] | any;
  }

  export interface Movable {
    free?: boolean;
    color?: Color | 'both';
    dests?: Dests;
    showDests?: boolean;
    events?: {
      after?: (orig: Key, dest: Key, metadata: MoveMetadata) => void;
      afterNewPiece?: (role: Role, key: Key, metadata: MoveMetadata) => void;
    };
    rookOffSquare?: boolean;
  }

  export interface Premoveable extends Movable {
    showDests?: boolean;
    castle?: boolean;
    events?: {
      set?: (orig: Key, dest: Key, metadata?: DropMetadata) => void;
      unset?: () => void;
    };
  }
  
  export interface Predroppable {
    enabled?: boolean;
    events?: {
      set?: (role: Role, key: Key) => void;
      unset?: () => void;
    };
  }

  export interface Draggable {
    enabled?: boolean;
    distance?: number;
    autoDistance?: boolean;
    showGhost?: boolean;
    deleteOnDropOff?: boolean;
  }

  export interface Selectable {
    enabled?: boolean;
  }

  export interface Highlight {
    lastMove?: boolean;
    check?: boolean;
  }

  export interface Animation {
    enabled?: boolean;
    duration?: number;
  }

  export interface Events {
    change?: () => void;
    move?: (orig: Key, dest: Key, capturedPiece?: Piece) => void;
    drop?: (orig: Key, dest: Key, role?: Role, newPiece?: Piece, oldPiece?: Piece) => void;
    select?: (key: Key) => void;
    insert?: (elements: Elements) => void;
  }

  export interface Drawable {
    enabled?: boolean;
    shapes?: Shape[];
    autoShapes?: boolean;
    brushes?: Brushes;
    onChange?: (shapes: Shape[]) => void;
  }

  export interface Shape {
    orig: Key;
    dest?: Key;
    brush: string;
    piece?: PieceShape;
    modifiers?: ShapeModifiers;
    customSvg?: string;
  }
  
  export interface PieceShape {
    role: Role;
    color: Color;
    scale?: number;
  }
  
  export interface ShapeModifiers {
    lineWidth?: number;
  }

  export interface Brushes {
    [name: string]: Brush;
  }

  export interface Brush {
    key: string;
    color: string;
    opacity: number;
    lineWidth: number;
  }
  
  export interface Elements {
    [key: string]: HTMLElement;
  }

  export interface MoveMetadata {
    premove?: boolean;
    ctrlKey?: boolean;
    holdTime?: number;
    captured?: Piece;
    predrop?: boolean;
  }

  export interface DropMetadata {
    piece: Piece;
    isPremove: boolean;
  }

  export interface State {
    fen: FEN;
    orientation: Color;
    turnColor: Color;
    lastMove?: Key[];
    check?: Key;
    selected?: Key;
    movable: {
      color?: Color | 'both';
      dests?: Dests;
      showDests?: boolean;
    };
  }

  // Изменяем экспорт на именованный, если Chessground экспортируется как именованная функция/класс
  export function Chessground(element: HTMLElement, config: Config): Api;
  // Если это класс, то:
  // export class Chessground {
  //   constructor(element: HTMLElement, config: Config): Api;
  //   // ... другие статические методы или свойства, если они есть и нужны
  // }
}
