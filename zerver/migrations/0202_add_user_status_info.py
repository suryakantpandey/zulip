# -*- coding: utf-8 -*-
# Generated by Django 1.11.18 on 2019-01-19 19:59
from __future__ import unicode_literals

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('zerver', '0201_zoom_video_chat'),
    ]

    operations = [
        migrations.AddField(
            model_name='userstatus',
            name='status_text',
            field=models.CharField(default='', max_length=255),
        ),
        migrations.AlterField(
            model_name='userstatus',
            name='status',
            field=models.PositiveSmallIntegerField(default=0),
        ),
    ]
