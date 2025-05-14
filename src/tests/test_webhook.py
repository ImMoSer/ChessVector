import requests
import json
import time

# --- URL ваших n8n вебхуков ---
TEST_WEBHOOK="https://service.mo3er.com/webhook/stormFen"

# --- Общие заголовки ---
headers = {
    "Content-Type": "application/json",
    "Accept": "application/json"
}
# ------------------------

# --- Функция для отправки запроса и вывода результата ---
def make_request(url, data):
    print("-" * 40)
    print(f"Отправка POST запроса на: {url}")
    print(f"С данными: {json.dumps(data, indent=2)}")

    try:
        response = requests.post(url, headers=headers, json=data, timeout=20)

        print(f"\nСтатус ответа: {response.status_code}")
        print("Заголовки ответа:")
        for key, value in response.headers.items():
             print(f"  {key}: {value}")
        print("-" * 20) # Конец заголовков

        if response.ok:
            try:
                response_data = response.json()
                print("Ответ получен (JSON):")
                print(json.dumps(response_data, indent=2, ensure_ascii=False))
                return response_data
            except json.JSONDecodeError:
                print("Не удалось декодировать JSON из ответа.")
                print("Содержимое ответа (TEXT):")
                print(response.text)
        else:
            print(f"Ошибка запроса (Статус {response.status_code}):")
            print(response.text)

    except requests.exceptions.RequestException as e:
        print(f"\nОшибка при выполнении запроса: {e}")
    except Exception as e:
        print(f"\nПроизошла непредвиденная ошибка: {e}")

    print("-" * 40)
    return None
# ---------------------------------------------------------

# --- Тестирование (каждый вебхук по разу) ---

# 1. Запрос данных пользователя
print("ШАГ 1: Запрос данных пользователя...")
get_user_payload = {
    "lichess_id": "valid_all",
    "pieceCount": 4,
    "rating": 600,
    
}
user_data_response = make_request(TEST_WEBHOOK, get_user_payload)



