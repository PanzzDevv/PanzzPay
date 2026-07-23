package com.panzzpay.forwarder

import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 34])
class MainActivityLaunchTest {

    @Test
    fun mainActivityInflatesAndCompletesInitialLifecycle() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()

        assertNotNull(activity.findViewById<TextView>(R.id.tvPermissionStatus))
        assertNotNull(activity.findViewById<TextView>(R.id.etWebhookUrl))
        assertNotNull(activity.findViewById<TextView>(R.id.btnSave))
        assertNotNull(activity.findViewById<TextView>(R.id.btnGrantPermission))
        assertNotNull(activity.findViewById<TextView>(R.id.btnTestWebhook))
        
        val versionName = activity.packageManager
            .getPackageInfo(activity.packageName, 0)
            .versionName
        assertEquals(
            activity.getString(R.string.app_version_format, versionName),
            activity.findViewById<TextView>(R.id.tvAppVersion).text.toString()
        )

        controller.pause().stop().destroy()
    }
}
