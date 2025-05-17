// src/core/sound.service.ts
import logger from '../utils/logger';

/**
 * Определяет все возможные типы звуков, которые могут быть воспроизведены в приложении.
 */
export type SoundType =
  | 'move'                     // Обычный ход фигуры
  | 'capture'                  // Взятие фигуры
  | 'check'                    // Шах
  | 'promote'                  // Превращение пешки
  | 'stalemate'                // Пат (использует lachen.wav)
  | 'puzzle_playout_start'     // Начало стадии доигрывания в пазле (finish-him.wav)
  | 'puzzle_user_lost'         // Пользователь проиграл в пазле (fatality.wav)
  | 'puzzle_user_won';         // Пользователь выиграл в пазле (flawless-victory.wav)
  // Можно добавить 'castle' (рокировка), если нужен отдельный звук

/**
 * Карта, связывающая SoundType с путем к аудиофайлу в папке /public/audio/.
 * Vite автоматически обрабатывает файлы из /public, делая их доступными по корневому пути.
 */
const soundFiles: Record<SoundType, string> = {
  move: '/audio/ChessCOM_move.mp3',
  capture: '/audio/ChessCOM_capture.mp3',
  check: '/audio/ChessCOM_check.mp3',
  promote: '/audio/ChessCOM_promote.mp3',
  stalemate: '/audio/lachen.wav',
  puzzle_playout_start: '/audio/finish-him.wav',
  puzzle_user_lost: '/audio/fatality.wav',
  puzzle_user_won: '/audio/flawless-victory.wav',
};

class SoundServiceController {
  private audioCache: Map<SoundType, HTMLAudioElement> = new Map();
  private isInitialized: boolean = false;
  private initPromise: Promise<void>;
  private resolveInitPromise!: () => void;
  private rejectInitPromise!: (reason?: any) => void;

  constructor() {
    // Создаем промис, который будет разрешен после инициализации
    this.initPromise = new Promise<void>((resolve, reject) => {
      this.resolveInitPromise = resolve;
      this.rejectInitPromise = reject;
    });
    // Запускаем асинхронную инициализацию
    this.initializeAudio();
  }

  /**
   * Асинхронно загружает все аудиофайлы, указанные в soundFiles.
   * Использует событие 'canplaythrough' для определения успешной загрузки.
   */
  private async initializeAudio(): Promise<void> {
    logger.info('[SoundService] Initializing audio assets...');
    const loadPromises: Promise<void>[] = [];

    // Итерируемся по всем ключам (SoundType) в soundFiles
    for (const key in soundFiles) {
      const soundName = key as SoundType;
      const path = soundFiles[soundName];
      const audio = new Audio(path);

      // Создаем промис для каждого аудиофайла
      const loadPromise = new Promise<void>((resolve, reject) => {
        // Событие 'canplaythrough' означает, что аудио загружено достаточно для воспроизведения до конца без задержек
        audio.oncanplaythrough = () => {
          this.audioCache.set(soundName, audio);
          logger.debug(`[SoundService] Audio loaded successfully: ${soundName} from ${path}`);
          resolve();
        };
        // Обработка ошибок загрузки
        audio.onerror = (e) => {
          const errorMessage = `Error loading audio: ${soundName} from ${path}`;
          logger.error(`[SoundService] ${errorMessage}`, e);
          // Отклоняем промис с ошибкой, чтобы Promise.all мог это обработать
          reject(new Error(errorMessage));
        };
        // Начинаем загрузку (браузер делает это автоматически при создании new Audio(), но preload='auto' может помочь)
        audio.preload = 'auto';
      });
      loadPromises.push(loadPromise);
    }

    try {
      // Ожидаем завершения загрузки всех аудиофайлов
      await Promise.all(loadPromises);
      this.isInitialized = true;
      logger.info('[SoundService] All audio assets initialized successfully.');
      this.resolveInitPromise(); // Разрешаем промис инициализации
    } catch (error) {
      logger.error('[SoundService] Failed to initialize one or more audio assets.', error);
      this.rejectInitPromise(error); // Отклоняем промис инициализации
      // В этом случае isInitialized останется false, и playSound будет предупреждать об этом.
    }
  }

  /**
   * Воспроизводит указанный звук.
   * @param soundName - Тип звука для воспроизведения (ключ из SoundType).
   */
  public playSound(soundName: SoundType): void {
    if (!this.isInitialized) {
      logger.warn(`[SoundService] Audio not yet initialized. Cannot play: ${soundName}. Waiting for initialization...`);
      // Можно добавить логику ожидания this.initPromise, если это критично,
      // но для игровых звуков обычно лучше просто пропустить, если не готово.
      this.initPromise.then(() => {
        logger.info(`[SoundService] Initialization complete after waiting. Retrying to play: ${soundName}`);
        this.playSoundInternal(soundName);
      }).catch(error => {
        logger.warn(`[SoundService] Initialization failed, cannot play ${soundName}. Error: ${error?.message || error}`);
      });
      return;
    }
    this.playSoundInternal(soundName);
  }

  /**
   * Внутренний метод для воспроизведения звука после проверки инициализации.
   */
  private playSoundInternal(soundName: SoundType): void {
    const audio = this.audioCache.get(soundName);
    if (audio) {
      audio.currentTime = 0; // Перематываем на начало, чтобы звук всегда играл с начала
      audio.play().catch(error => {
        // Ошибки воспроизведения могут возникать из-за политики браузера (например, нет взаимодействия пользователя со страницей)
        // или если предыдущий вызов play() для того же звука еще не завершился.
        // Для коротких игровых звуков это обычно не критично.
        logger.warn(`[SoundService] Error playing sound '${soundName}':`, error.message);
      });
    } else {
      logger.warn(`[SoundService] Sound not found in cache: ${soundName}. Was it loaded correctly?`);
    }
  }

  /**
   * Возвращает промис, который разрешается, когда все звуки загружены.
   * Полезно, если нужно дождаться загрузки звуков перед какими-то действиями.
   */
  public async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return Promise.resolve();
    }
    return this.initPromise;
  }

  /**
   * Проверяет, был ли сервис успешно инициализирован.
   * @returns true, если все звуки загружены, иначе false.
   */
  public get isReady(): boolean {
    return this.isInitialized;
  }
}

/**
 * Экспортируем синглтон-экземпляр SoundService.
 * Сервис начнет загрузку звуков сразу после импорта этого файла.
 */
export const SoundService = new SoundServiceController();
