// Фиктивный конфиг Firebase для стенда — копируется в frontend/src/ts/constants/firebase-config(-live).ts
// перед сборкой monkeytype (см. bench/repos/monkeytype.ts).
//
// Пустой конфиг из их firebase-config-example.ts не годится: до коммита 6902b407e (27.10.2025,
// «fix: run without firebase-config») при ошибке инициализации Firebase приложение навсегда оставалось
// на экране загрузки — первые 20 коммитов сбора упали (measure_failed: нет `#words .word` за 60 с).
// С непустыми полями initializeApp/getAuth проходят на всех версиях; пользователь — не вошедший,
// сохранённого входа нет, поэтому к серверам Google Firebase не обращается (на всякий случай они заблокированы).

export const firebaseConfig = {
  apiKey: "AIzaSyBenchFakeKeyNotARealProject000000",
  authDomain: "bench-fake.firebaseapp.com",
  databaseURL: "",
  projectId: "bench-fake",
  storageBucket: "bench-fake.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000",
};
