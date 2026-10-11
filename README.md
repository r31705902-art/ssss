# autocut — авто-нарезка Twitch-стримов

URL стрима → GitHub Actions (до 25 воркеров: каждый качает свой кусок HLS, делает 360p-прокси, faster-whisper large-v3-turbo + диаризация sherpa-onnx) →
склейка транскрипта со спикерами `[1] [2] …` → агент Gemini (`gemini-3.8-flash`, нативный API: кадры / видео 1–24 fps со звуком / аудио / превью блюра) →
рендер в GitHub Actions (вырезка скучного, блюр рекламы, бип матов) → ZIP/TAR с видео, превью, `.txt` (описание + таймкоды для YouTube), `.srt`, `.json`.

* `worker/` — python-скрипты воркеров (plan / ingest / merge / render / assemble), `.github/workflows/{ingest,render}.yml`.
* `server/` — веб-UI + оркестратор (Node 24, без зависимостей). `node server/server.js` или `require('server/server.js').mount()` → `handle(req,res,path)`.
* Конфиг: `~/autocut-data/config.json` (blomp, github, gemini, nvidia, password, hook_secret, base, defaults, state_prefix, tmp_dir).
* Хранилище: Blomp (Swift). Листинг контейнера у Blomp не работает, а некоторые имена объектов он «съедает» — код пишет такие объекты под `имя~N.ext`
  и сам их находит; состояние задач зеркалится в `autocut/state/`.
* Секреты репозитория: `BLOMP_USER`, `BLOMP_PASS`, `CALLBACK_URL` (= `https://<site>/cut`), `HOOK_SECRET`.
