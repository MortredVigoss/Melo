package com.melo.android.chat

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import com.melo.android.MainActivity
import com.melo.android.MeloApplication
import com.melo.android.R

class ReplyService : Service() {
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("reply", "Melo 正在回复", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, ReplyService::class.java).setAction("cancel"), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, "reply").setSmallIcon(R.drawable.ic_melo).setContentTitle("Melo 正在处理请求")
            .setContentText("返回 App 查看进度，或取消本次请求").setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "取消", stop).build()).build()
        if (android.os.Build.VERSION.SDK_INT >= 29) startForeground(1201, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(1201, notification)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "cancel") { (application as MeloApplication).engine.cancel(); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onTimeout(startId: Int, fgsType: Int) { (application as MeloApplication).engine.cancel(); stopSelf() }
    override fun onBind(intent: Intent?): IBinder? = null
}
