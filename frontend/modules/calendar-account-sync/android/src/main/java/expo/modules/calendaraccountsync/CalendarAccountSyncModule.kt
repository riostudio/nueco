package expo.modules.calendaraccountsync

import android.accounts.Account
import android.content.ContentResolver
import android.os.Bundle
import android.provider.CalendarContract
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Bumps the Calendar provider's sync adapter for one account so a just-written event reaches
// Google/Exchange servers immediately instead of waiting for Android's normal periodic sync
// window (which can be a couple of minutes). Best-effort: a failed/ignored request just falls
// back to that normal schedule, so failures are swallowed rather than surfaced.
class CalendarAccountSyncModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CalendarAccountSync")

    Function("requestSync") { accountName: String, accountType: String ->
      try {
        val account = Account(accountName, accountType)
        val extras = Bundle()
        extras.putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
        extras.putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
        ContentResolver.requestSync(account, CalendarContract.AUTHORITY, extras)
      } catch (e: Exception) {
        // ignored - see class comment
      }
    }
  }
}
