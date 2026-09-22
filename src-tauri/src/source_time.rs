//! 时间工具（免 chrono）：日历日 ↔ 公历分量（Howard Hinnant 算法）。
//!
//! `git.rs` 里已有一份私有实现（提交热力用）；这里抽成公开版供
//! `resources::now_iso` / `transfer` 的时间戳与备份文件名复用。

/// UNIX 天数 → (年, 月, 日)（proleptic Gregorian；Hinnant civil_from_days）。
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }), m, d)
}
