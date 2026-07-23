package com.panzzpay.forwarder

import android.widget.TextView
import com.google.android.material.materialswitch.MaterialSwitch
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
        val serviceSwitch = activity.findViewById<MaterialSwitch>(R.id.switchService)
        val voiceSwitch = activity.findViewById<MaterialSwitch>(R.id.switchVoice)
        assertEquals(activity.getString(R.string.switch_on), serviceSwitch.textOn)
        assertEquals(activity.getString(R.string.switch_off), serviceSwitch.textOff)
        assertEquals(activity.getString(R.string.switch_on), voiceSwitch.textOn)
        assertEquals(activity.getString(R.string.switch_off), voiceSwitch.textOff)
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
