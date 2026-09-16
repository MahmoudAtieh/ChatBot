# Arabic Sofa WhatsApp Shopping Assistant

نسخة أولية عملية وخفيفة لربط WhatsApp Cloud API مع OpenAI وكتالوج Shopify. المشروع لا يستخدم fine-tuning أو Vector DB؛ بل يحمّل أسلوب المتجر والـplaybooks مرة واحدة عند التشغيل، ويستدعي مصادر الحقيقة عند الحاجة فقط.

> **الحالة الحالية: Alpha للتطوير والاختبارات. لا تربطه برقم WhatsApp الحقيقي قبل ربط تحويلات الموظفين وإجراء اختبار تكاملي فعلي بالخدمات الثلاث.**

## ما تم تنفيذه

- رد سريع بدون LLM للتحية، الشكر، والتنبيه عند إرسال بيانات دفع حساسة.
- تحميل `style_reference.json` و`playbook_candidates.json` من `./Data-Processing` والتحقق الصارم من بنيتهما وهوية المتجر.
- عدم تفعيل FAQ وسياسات الشحن والاسترجاع إلا بعد اعتماد الملف والمدخلات صراحةً.
- OpenAI Responses API مع Structured Outputs ودورتين كحد أقصى لاستدعاء الأدوات.
- أدوات محدودة: بحث Shopify، FAQ، السياسات، وتجهيز التحويل لموظف.
- Shopify Admin GraphQL باستعلام يملكه السيرفر وصلاحية قراءة فقط؛ الـAI لا يستطيع إرسال GraphQL خام.
- Meta webhook مع التحقق من `X-Hub-Signature-256` على البايتات الأصلية، فلترة رقم الهاتف، وحفظ `wamid` قبل إرسال `200`.
- PostgreSQL durable queue بحمولة مشفرة، leases، إعادة محاولة بتأخير تدريجي، ومنع معالجة الرسائل المتكررة.
- PostgreSQL للمحادثات والتحويلات، مع بديل in-memory غير دائم للتطوير المحلي فقط.
- Endpoint محلي لاختبار المحادثة قبل ربط WhatsApp.

## مسار الرسالة

```text
Meta webhook
  -> التحقق من التوقيع
  -> تشفير الرسالة وحفظها في PostgreSQL (أو تجاهل wamid المكرر)
  -> إرسال 200 إلى Meta
  -> durable worker يحجز الرسالة بمدة lease
  -> fast path إن أمكن
  -> سياق قصير + أسلوب المتجر والـplaybook
  -> OpenAI
  -> Shopify / FAQ / Policy / Handoff عند الحاجة
  -> رد واحد مختصر
  -> Meta WhatsApp
  -> done، أو retry بتأخير تدريجي، أو dead بعد استنفاد المحاولات
```

## التشغيل محلياً

المتطلبات: Node.js 22 أو أحدث. مجلد `Data-Processing` الآمن والنهائي موجود داخل المشروع.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

يعمل السيرفر افتراضياً على `http://localhost:3000`. افحصه عبر:

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/ready
```

وجرّب fast path بدون أي مفاتيح خارجية:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/chat/test `
  -ContentType "application/json" `
  -Body '{"conversation_id":"local-1","message":"السلام عليكم"}'
```

الرسائل التي تحتاج فهماً أو بحثاً ستتحول بأمان للفريق إلى أن تضيف `OPENAI_API_KEY` و`OPENAI_MODEL`.

## الإعدادات

انسخ `.env.example` إلى `.env` ثم أضف القيم الفعلية:

- OpenAI: `OPENAI_API_KEY` و`OPENAI_MODEL`.
- Shopify: `SHOPIFY_STORE_DOMAIN` و`SHOPIFY_ADMIN_ACCESS_TOKEN`. الصلاحية الدنيا للنسخة الحالية هي `read_products`، وإصدار API مثبت على `2026-07`.
- Meta: access token، phone number ID، app secret، verify token، وإصدار Graph API النشط في تطبيقك.
- PostgreSQL: `DATABASE_URL`. بدونه تُحفظ المحادثات بالذاكرة وتُفقد عند إعادة التشغيل.
- الخصوصية: ضع قيمة عشوائية قوية في `CONVERSATION_HASH_SECRET` لإنشاء معرفات محادثات HMAC غير قابلة للتخمين المباشر.
- تشفير الطابور: عند ضبط `DATABASE_URL` يجب ضبط `QUEUE_ENCRYPTION_KEYS` و`QUEUE_ENCRYPTION_ACTIVE_KEY_ID`. لا تُخزن المفاتيح في Git أو قاعدة البيانات.
- الـworker: القيم الافتراضية مناسبة كبداية. يمكن ضبط حجم الدفعة، lease، عدد المحاولات، وفترات التأخير من متغيرات `WORKER_*` في `.env.example`.

في الإنتاج يجب أن تكون جميع القيم السابقة موجودة، و`ENABLE_TEST_CHAT=false`، وإلا يفشل التشغيل بشكل صريح.

## PostgreSQL

المشروع يدعم PostgreSQL 16 أو أحدث. لقاعدة بيانات جديدة، نفّذ [001_initial.sql](./db/migrations/001_initial.sql) مرة واحدة قبل تشغيل التطبيق. إذا كانت القاعدة قد أُنشئت بالنسخة القديمة من `001`، أوقف التطبيق والـworkers ثم نفّذ [002_durable_inbound_queue.sql](./db/migrations/002_durable_inbound_queue.sql). الترقية تغلق بصمات الرسائل القديمة غير القابلة لإعادة التشغيل بحالة `dead`، لأنها لم تكن تحتوي على payload.

أنشئ مفتاح AES-256 عشوائياً (32 بايت بصيغة base64url):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

ثم ضعه باسم مفتاح ثابت، مثلاً:

```dotenv
QUEUE_ENCRYPTION_KEYS=2026-09:ضع-هنا-ناتج-الأمر
QUEUE_ENCRYPTION_ACTIVE_KEY_ID=2026-09
```

عند تدوير المفتاح، أضف المفتاح الجديد واجعله active واحتفظ بالقديم ضمن القائمة حتى تنتهي كل الرسائل المشفرة به؛ مثال الصيغة متعددة المفاتيح: `new-id:new-key,old-id:old-key`.

لا نخزن رقم WhatsApp كمفتاح للمحادثة؛ يُحوّل إلى HMAC-SHA-256 بمفتاح سري. نص المحادثة نفسه يُحفظ لتوفير السياق، لذلك يجب ضبط مدة الاحتفاظ والصلاحيات والنسخ الاحتياطي قبل الإطلاق.

الطابور الدائم يعمل فقط مع PostgreSQL. البديل in-memory مناسب للتطوير، لكنه يفقد الرسائل عند إعادة تشغيل العملية ولا يعطي ضمان الاستعادة. عند النجاح أو الوصول إلى `dead` تُمسح حمولة الطابور المشفرة ويُحتفظ بالحالة ورمز الخطأ فقط. التسليم إلى Meta هو **at-least-once**: في الحالة النادرة التي تقبل فيها Meta الرد ثم تتعطل العملية قبل تسجيل `done`، قد يعيد الـworker إرسال الرد. لا يمكن ضمان exactly-once دون مفتاح idempotency معتمد من مزود الإرسال.

## تفعيل FAQ والسياسات

حالياً هذه الملفات مقفلة عمداً لأنها `pending_owner_review` و`runtime_eligible: false`:

- `editable_knowledge/faq.json`
- `editable_knowledge/refund_policy.json`
- `editable_knowledge/shipping_policy.json`

للتفعيل بعد مراجعة صاحب المتجر:

1. غيّر `review_status` للملف إلى `approved`.
2. غيّر `runtime_eligible` للملف إلى `true`.
3. في FAQ فقط: اجعل كل مدخل مقبول `status: "approved"` و`runtime_eligible: true`.
4. أعد تشغيل السيرفر؛ لا يوجد file watcher مقصوداً.

لا تُحمّل ملفات `static_faq_candidates.jsonl` أو `evaluation_cases.jsonl` أو `extraction_report.json` أثناء التشغيل.

## الاختبارات

```powershell
npm test
npm run typecheck
npm run build
```

تغطي الاختبارات حالياً: بوابات اعتماد الداتا، fast paths، عدم تخزين بيانات الدفع الظاهرة، ترتيب رسائل المحادثة، منع التكرار، توقيع Meta، استخراج الرسائل، الرد السريع على webhook، وبناء بحث Shopify الآمن.

## حدود النسخة الحالية قبل الإطلاق

- حالة الطلب والتعديل أو الإلغاء تتحول لموظف؛ لم نضف قراءة الطلبات قبل تصميم تحقق آمن من هوية العميل.
- يُحفظ Meta media ID مع المحادثة والتحويل ليستطيع تكامل الموظفين استرجاع الصورة لاحقاً؛ تنزيل الصورة وفهم محتواها آلياً مرحلة لاحقة.
- تحويل الموظف يحفظ السبب والملخص ومراجع الصور في جدول `handoffs`، لكنه غير مربوط بعد بوجهة أو لوحة تسمح للموظف باستلام الحالة والرد على العميل.
- تسليم الردود إلى Meta هو at-least-once، لذلك تبقى احتمالية تكرار نادرة إذا حدث تعطل في اللحظة بين قبول Meta للرد وتسجيل اكتمال المهمة.
- يلزم اختبار تكاملي فعلي بمفاتيح sandbox/test الخاصة بـMeta وShopify وOpenAI.

## المراجع الرسمية

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Shopify Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql/latest)
- [Meta WhatsApp Cloud API webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components/)
