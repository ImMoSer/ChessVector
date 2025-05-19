// src/features/finishHim/finishHim.types.ts

// Определяем возможные типы эндшпилей для режима FinishHim
export const FINISH_HIM_PUZZLE_TYPES = [
  "endgame",         // Общий эндшпиль
  "advancedPawn",    // Продвинутая пешка
  "rookEndgame",     // Ладейный эндшпиль
  "bishopEndgame",   // Слонновый эндшпиль (добавил, т.к. был knight дважды)
  "knightEndgame",   // Коневой эндшпиль
  "queenEndgame",    // Ферзевый эндшпиль
  "queenRookEndgame",// Ферзь + Ладья эндшпиль
  "pawnEndgame",     // Пешечный эндшпиль
  "zugzwang"         // Цугцванг
] as const; // Используем "as const" для создания union типа из строковых литералов

export type FinishHimPuzzleType = typeof FINISH_HIM_PUZZLE_TYPES[number];

// Можно также определить интерфейс для настроек пользователя, если они будут влиять на pieceCount и rating
export interface FinishHimUserSettings {
  defaultRating: number;
  defaultPieceCount: number;
  // Другие возможные настройки
}
