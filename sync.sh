#!/bin/bash

# مرحله ۱: اضافه کردن همه فایل‌ها
git add .

# مرحله ۲: گرفتن پیام کامیت (اگر پیام ندادی، پیش‌فرض می‌گذارد)
msg="${1:-Update project}"
git commit -m "$msg"

# مرحله ۳: ارسال به گیت‌هاب
git push -u origin main

echo "✅ پروژه با موفقیت آپلود شد!"
