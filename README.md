# Arabic Sofa WhatsApp Shopping Assistant

نسخة أولية عملية وخفيفة لربط WhatsApp Cloud API مع OpenAI وكتالوج Shopify. المشروع لا يستخدم fine-tuning أو Vector DB؛ بل يحمّل أسلوب المتجر والـplaybooks مرة واحدة عند التشغيل، ويستدعي مصادر الحقيقة عند الحاجة فقط.

> **الحالة الحالية: Alpha للتطوير والاختبارات. لا تربطه برقم WhatsApp الحقيقي قبل تنفيذ الـdurable worker وربط تحويلات الموظفين الموضحين في آخر الملف.**

## ما تم تنفيذه

- رد سريع بدون LLM للتحية، الشكر، والتنبيه عند إرسال بيانات دفع حساسة.
- تحميل `style_reference.json` و`playbook_candidates.json` من `./Data-Processing` والتحقق الصارم من بنيتهما وهوية المتجر.
- عدم تفعيل FAQ وسياسات الشحن والاسترجاع إلا بعد اعتماد الملف والمدخلات صراحةً.
- OpenAI Responses API مع Structured Outputs ودورتين كحد أقصى لاستدعاء الأدوات.
- أدوات محدودة: بحث Shopify، FAQ، السياسات، وتجهيز التحويل لموظف.
- Shopify Admin GraphQL باستعلام يملكه السيرفر وصلاحية قراءة فقط؛ الـAI لا يستطيع إرسال GraphQL خام.
- Meta webhook مع التحقق من `X-Hub-Signature-256` على البايتات الأصلية، فلترة رقم الهاتف، ومنع معالجة `wamid` مرتين.
- PostgreSQL للمحادثات والتحويلات ومنع التكرار، مع بديل in-memory للتطوير المحلي.
- Endpoint محلي لاختبار المحادثة قبل ربط WhatsApp.

## مسار الرسالة

```text
Meta webhook
  -> التحقق من التوقيع ومنع التكرار
  -> fast path إن أمكن
  -> سياق قصير + أسلوب المتجر والـplaybook
  -> OpenAI
  -> Shopify / FAQ / Policy / Handoff عند الحاجة
  -> رد واحد مختصر
  -> Meta WhatsApp
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

في الإنتاج يجب أن تكون جميع القيم السابقة موجودة، و`ENABLE_TEST_CHAT=false`، وإلا يفشل التشغيل بشكل صريح.

## PostgreSQL

نفّذ [001_initial.sql](./db/migrations/001_initial.sql) مرة واحدة على قاعدة البيانات قبل تشغيل التطبيق باستخدام أداة إدارة PostgreSQL التي تعتمدها.

لا نخزن رقم WhatsApp كمفتاح للمحادثة؛ يُحوّل إلى HMAC-SHA-256 بمفتاح سري. نص المحادثة نفسه يُحفظ لتوفير السياق، لذلك يجب ضبط مدة الاحتفاظ والصلاحيات والنسخ الاحتياطي قبل الإطلاق.

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
- معالجة webhook تبدأ بعد حفظ بصمة الرسالة وإرسال `200`. قبل أي إطلاق فعلي، يجب إضافة PostgreSQL durable worker يعيد المحاولات ويلتقط الرسائل المتوقفة بعد تعطل العملية.
- يلزم اختبار تكاملي فعلي بمفاتيح sandbox/test الخاصة بـMeta وShopify وOpenAI.

## المراجع الرسمية

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Shopify Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql/latest)
- [Meta WhatsApp Cloud API webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components/)
