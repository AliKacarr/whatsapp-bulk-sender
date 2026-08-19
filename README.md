# WhatsApp Toplu Mesaj Gönderici

Excel dosyalarınızdaki sipariş verilerini otomatik okuyan, Meta **WhatsApp Cloud API** entegrasyonu ve dinamik **mesaj şablonlarıyla** müşterilere tek tıkla **toplu ve otomatik WhatsApp mesajı** göndermenizi sağlayan modern, güvenli web tabanlı yönetim paneli.

![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)
![Express.js](https://img.shields.io/badge/Express.js-4.x-black.svg)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248.svg)
![WhatsApp Cloud API](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366.svg)
![Docker](https://img.shields.io/badge/Docker-Supported-blue)

---

## Öne Çıkan Özellikler

- **Meta WhatsApp Cloud API Entegrasyonu:** Resmi Meta Graph API altyapısıyla kesintisiz, hızlı ve güvenli mesaj gönderimi.
- **Otomatik & Toplu Gönderim:** İster tekli ister filtreleme ve çoklu seçim yaparak müşterilerinize şablonlarla otomatik WhatsApp mesajı gönderin.
- **Excel Sipariş İçe Aktarma:** `.xlsx` formatındaki sipariş listelerini tek tıkla yükleyin; tüm dosyalar MongoDB ile otomatik senkronize edilir.
- **Dinamik Meta Şablon Eşleme:** Meta'da onaylı şablon parametrelerini (`{{1}}`, `{{2}}`...) Excel sütunlarıyla görsel olarak eşleştirin.
- **Kargo Takip Entegrasyonu:** PTT ve Sürat Kargo takip linklerini müşteriye özel olarak tek tıkla otomatik oluşturun.
- **Kullanıcı Girişi ve Oturum Güvenliği:** MongoDB tabanlı kullanıcı kimlik doğrulaması ve güvenli token oturum yönetimi.
- **Canlı Webhook Altyapısı:** `X-Hub-Signature-256` doğrulamasıyla güvenli, anında yanıt veren (zero-delay) ve gelen mesajları/durumları (`sent`, `delivered`, `read`, `failed`) yakalayan webhook.
- **Profil & Şablon Yönetimi:** Farklı mağaza veya iş süreçleri için özel profiller oluşturun.

---

## Teknolojiler

- **Backend:** Node.js, Express.js
- **Veritabanı:** MongoDB
- **Excel İşleme:** ExcelJS
- **WhatsApp API:** Meta Graph API v25.0 (Cloud API)
- **Frontend:** Modern HTML5, Vanilla CSS3 (Dark Glassmorphism), JavaScript
- **Konteynerizasyon:** Docker

---

## 📸 Ekran Görüntüleri

| Ana Sayfa | Gizlenen Siparişler |
|:-----------------:|:-------------------:|
| <img src="public/site_gorselleri/1- Ana Sayfa.png" alt="Ana Sayfa" width="400"> | <img src="public/site_gorselleri/2- Gizlenen Siparişler.png" alt="Gizlenen Siparişler" width="400"> |

| Profiller | Dosya Yönetimi |
|:-----------------:|:-------------------:|
| <img src="public/site_gorselleri/3- Profiller.png" alt="Profiller" width="400"> | <img src="public/site_gorselleri/4- Excel Dosyaları Yönetimi.png" alt="Dosya Yönetimi" width="400"> |

---

## Hızlı Başlangıç

#### 1. Bağımlılıkları Yükleyin
```bash
npm install
```

#### 2. Çevre Değişkenlerini (`.env`) Ayarlayın
Kök dizinde `.env` dosyası oluşturun ve bilgilerinizi ekleyin:
```env
MONGODB_URI=mongodb+srv:...

# Meta WhatsApp Cloud API Bilgileri
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_ACCESS_TOKEN=EAAB...

# Webhook Güvenlik Ayarları
VERIFY_TOKEN=guclu_bir_dogrulama_tokeni
APP_SECRET=meta_app_secret_kodunuz
```

#### 3. Sunucuyu Başlatın
```bash
node server.js
```

> **Windows Kullanıcıları:** Root dizinindeki `start.bat` dosyasına çift tıklayarak uygulamayı başlatabilirsiniz.

Servis başladığında tarayıcınızda otomatik olarak **`http://localhost:8000/`** açılacaktır.

---

## Kullanım Rehberi

1. **Giriş Yapın:** Varsayılan yönetici bilgileriyle (`admin` / `admin123`) güvenli giriş yapın.
2. **Profil Seçin:** İhtiyacınıza göre mağaza profili seçin veya yeni bir profil oluşturun.
3. **Excel Yükleyin:** Sipariş listenizi sürükleyip bırakın veya dosya yöneticisinden yükleyin.
4. **Şablon & Parametreleri Belirleyin:** Sol panelden Meta şablon adınızı yazın ve parametreleri (`{{1}}`, `{{2}}`...) Excel sütunlarıyla eşleştirip kaydedin.
5. **Gönderimi Başlatın:** Listeden siparişleri seçin veya **"Tüm Bekleyenlere Oto Mesaj Gönder"** butonuyla toplu gönderimi başlatın.

---

## Geliştirici

**Ali Kaçar**

[![Instagram](https://img.shields.io/badge/Instagram-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/alikacar23/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/alikacar23/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/AliKacarr)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)](https://www.youtube.com/@alikacardev)

[alikacardev@gmail.com](mailto:alikacardev@gmail.com)

---

## Lisans

Bu proje [MIT Lisansı](LICENSE.txt) ile lisanslanmıştır.