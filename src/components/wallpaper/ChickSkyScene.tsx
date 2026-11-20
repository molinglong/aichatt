/**
 * 壁纸 · 小鸡天空的场景层(风格子档 data-wallpaper-style="chick" 专用)。
 *
 * B 方案蜡笔天空,2026-11-18 预览拍板: 浅色 = 蓝天白云太阳 + 草地散步小鸡;
 * 深色 = 夜空月亮星星 + 草地提灯小鸡。桌面端先行(1280×800 视窗,slice 铺满任意宽高),
 * 手机端由 CSS 整段隐藏(globals.css「主题: 壁纸 · 小鸡天空」段),暂降级为素底。
 *
 * 无状态纯静态 SVG,不 hydrate 不监听 —— 显隐全由 html 属性 + 纯 CSS 驱动
 * (与 .sky-wallpaper-photo 同一套路);飘云/小鸡起伏/星光闪烁的动画也全在 CSS。
 * 形象与 FocusLock/学习室书桌的 CrayonChick 同源: 身体 #fff0b8、描边 #e8a23c。
 * 2026-11-18 小鸡改版为「蛋壳宝宝」(C 案,design/preview-chick-redesign.html 定稿),
 * 本文件两套场景里的小鸡已同步换装;深色提灯小鸡灯笼挂翅尖下照亮蛋壳。
 *
 * ⚠ 落位约束: 壁纸层铺满整个窗口(含侧栏底下),内容区从 x≈450 起 ——
 * 焦点元素(小鸡/太阳/月亮)x 必须 ≥520,否则半透明侧栏底下会透出模糊光斑。
 */
export function ChickSkyScene() {
  return (
    <>
      {/* 浅色: 蓝天白云太阳 + 草地散步小鸡 ×2 */}
      <svg className="chick-scene-light" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g className="cloud-drift">
          <path d="M120 130 q5 -20 28 -16 q10 -15 33 -9 q25 -5 30 11 q18 1 15 15 q-2 12 -20 11 h-70 q-18 1 -16 -12z" fill="#fff" stroke="#9fc3e0" strokeWidth="3" strokeLinejoin="round" />
        </g>
        <g className="cloud-drift-2">
          <path d="M560 90 q4 -15 22 -12 q8 -11 26 -6 q19 -4 23 9 q14 1 12 11 q-2 10 -16 9 h-56 q-14 1 -11 -11z" fill="#fff" stroke="#9fc3e0" strokeWidth="2.8" strokeLinejoin="round" />
        </g>
        <g className="cloud-drift" transform="translate(-50 40)">
          <path d="M980 170 q4 -13 19 -10 q7 -9 20 -5 q14 -3 17 7 q10 1 8 9 q-2 8 -12 7 h-42 q-11 1 -10 -8z" fill="#fff" stroke="#9fc3e0" strokeWidth="2.4" strokeLinejoin="round" opacity=".85" />
        </g>
        <g transform="translate(1120 170)">
          <circle r="30" fill="#e8b03c" fillOpacity=".32" stroke="#e8a23c" strokeWidth="3" />
          <g stroke="#e8a23c" strokeWidth="2.8" strokeLinecap="round" opacity=".8">
            <path d="M0 -42 v-10 M0 42 v10 M-42 0 h-10 M42 0 h10" />
            <path d="M-30 -30 l-7 -7 M30 30 l7 7 M30 -30 l7 -7 M-30 30 l-7 7" />
          </g>
          <circle r="16" fill="#ffdf8e" opacity=".5" />
        </g>
        <path d="M-4 656 q60 -12 120 -3 q66 10 132 -3 q68 -12 136 0 q72 12 142 1 q66 -10 132 2 q66 12 134 3 q62 -8 128 1 q66 8 132 0 l0 148 -1284 0 z" fill="#fffdf4" />
        <path d="M-4 656 q60 -12 120 -3 q66 10 132 -3 q68 -12 136 0 q72 12 142 1 q66 -10 132 2 q66 12 134 3 q62 -8 128 1 q66 8 132 0" stroke="#e8a23c" strokeWidth="2.8" fill="none" opacity=".55" />
        <g stroke="#8fb96e" strokeWidth="3" strokeLinecap="round" fill="none" opacity=".8">
          <path d="M80 692 q3 -14 8 -1 M93 692 q3 -17 9 -2 M106 692 q2 -11 6 -1" />
          <path d="M420 684 q3 -13 7 -1 M432 684 q2 -16 8 -2" />
          <path d="M760 700 q3 -14 8 -1 M773 700 q3 -16 9 -2 M786 700 q2 -10 6 -1" />
          <path d="M1120 690 q3 -12 7 -1 M1132 690 q2 -15 8 -2" />
          <path d="M250 736 q3 -12 7 -1 M262 736 q2 -14 8 -2" />
        </g>
        <circle cx="500" cy="712" r="3" fill="#e05a6a" opacity=".55" />
        <circle cx="920" cy="706" r="2.6" fill="#e05a6a" opacity=".45" />
        <g className="chick-bob" transform="translate(560 652) scale(1.3) rotate(-4 32 34)">
          <path d="M27 18.8 l2.4 -5.8 3 5.2" stroke="#e8a23c" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M34.5 18.6 l3.4 -5.6 1.6 6" stroke="#e8a23c" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" fill="#fff0b8" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" stroke="#e8a23c" strokeWidth="2.2" fill="none" />
          <path d="M13.5 38 q-4.5 1.5 -3 5.5 q1.5 3.5 5.5 3" stroke="#e8a23c" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" stroke="#e8a23c" strokeWidth="2" strokeLinecap="round" fill="none" />
          <ellipse cx="26.8" cy="31.2" rx="2.2" ry="2.7" fill="#4a3a28" />
          <circle cx="27.6" cy="30.2" r=".85" fill="#fff" />
          <circle cx="26" cy="32.4" r=".45" fill="#fff" opacity=".75" />
          <ellipse cx="37.2" cy="31.2" rx="2.2" ry="2.7" fill="#4a3a28" />
          <circle cx="38" cy="30.2" r=".85" fill="#fff" />
          <circle cx="36.4" cy="32.4" r=".45" fill="#fff" opacity=".75" />
          <ellipse cx="20.8" cy="36.5" rx="3.9" ry="2.5" fill="#ffb3a0" />
          <ellipse cx="43.2" cy="36.5" rx="3.9" ry="2.5" fill="#ffb3a0" />
          <path d="M29.7 35.4 q2.4 -2 4.7 0 q-.85 2.5 -2.35 2.5 q-1.5 0 -2.35 -2.5 z" fill="#ff9a5c" />
          <path d="M13.5 44 q4.7 -4.2 9.6 0 q4.9 4.2 9.7 0 q4.7 -4.2 9.6 0 q4.8 4.2 9.6 0 l-.4 6.5 q-.5 6.5 -7.5 6.5 h-22.8 q-7 0 -7.5 -6.5 z" fill="#fffdf6" stroke="#e8a23c" strokeWidth="2.2" strokeLinejoin="round" />
          <circle cx="26" cy="52" r="1.5" fill="#ffb3a0" opacity=".8" />
          <circle cx="37" cy="54" r="1.2" fill="#9fc3e0" opacity=".7" />
        </g>
        <g className="chick-bob-2" transform="translate(940 690) scale(1.05) rotate(5 32 34)">
          <path d="M27 18.8 l2.4 -5.8 3 5.2" stroke="#e8a23c" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M34.5 18.6 l3.4 -5.6 1.6 6" stroke="#e8a23c" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" fill="#fff0b8" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" stroke="#e8a23c" strokeWidth="2.2" fill="none" />
          <path d="M13.5 38 q-4.5 1.5 -3 5.5 q1.5 3.5 5.5 3" stroke="#e8a23c" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" stroke="#e8a23c" strokeWidth="2" strokeLinecap="round" fill="none" />
          <ellipse cx="26.8" cy="31.2" rx="2.2" ry="2.7" fill="#4a3a28" />
          <circle cx="27.6" cy="30.2" r=".85" fill="#fff" />
          <circle cx="26" cy="32.4" r=".45" fill="#fff" opacity=".75" />
          <ellipse cx="37.2" cy="31.2" rx="2.2" ry="2.7" fill="#4a3a28" />
          <circle cx="38" cy="30.2" r=".85" fill="#fff" />
          <circle cx="36.4" cy="32.4" r=".45" fill="#fff" opacity=".75" />
          <ellipse cx="20.8" cy="36.5" rx="3.9" ry="2.5" fill="#ffb3a0" />
          <ellipse cx="43.2" cy="36.5" rx="3.9" ry="2.5" fill="#ffb3a0" />
          <path d="M29.7 35.4 q2.4 -2 4.7 0 q-.85 2.5 -2.35 2.5 q-1.5 0 -2.35 -2.5 z" fill="#ff9a5c" />
          <path d="M13.5 44 q4.7 -4.2 9.6 0 q4.9 4.2 9.7 0 q4.7 -4.2 9.6 0 q4.8 4.2 9.6 0 l-.4 6.5 q-.5 6.5 -7.5 6.5 h-22.8 q-7 0 -7.5 -6.5 z" fill="#fffdf6" stroke="#e8a23c" strokeWidth="2.2" strokeLinejoin="round" />
          <circle cx="26" cy="52" r="1.5" fill="#ffb3a0" opacity=".8" />
          <circle cx="37" cy="54" r="1.2" fill="#9fc3e0" opacity=".7" />
        </g>
      </svg>
      {/* 深色: 夜空月亮星星 + 草地提灯小鸡 */}
      <svg className="chick-scene-dark" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g fill="#e8b03c">
          <circle className="star-tw" cx="140" cy="110" r="2.4" opacity=".7" />
          <circle className="star-tw-2" cx="300" cy="70" r="1.8" opacity=".55" />
          <circle className="star-tw" cx="480" cy="140" r="2" opacity=".6" />
          <circle className="star-tw-2" cx="640" cy="84" r="2.4" opacity=".65" />
          <circle className="star-tw" cx="820" cy="280" r="1.8" opacity=".5" />
          <path className="star-tw-2" d="M700 180 l1.8 3.8 4 .6 -2.9 2.8 .8 4 -3.7 -2 -3.7 2 .8 -4 -2.9 -2.8 4 -.6 z" opacity=".75" />
          <path className="star-tw" d="M210 210 l1.4 3 3.2 .5 -2.3 2.3 .6 3.2 -2.9 -1.6 -2.9 1.6 .6 -3.2 -2.3 -2.3 3.2 -.5 z" opacity=".6" />
          <circle className="star-tw-2" cx="380" cy="330" r="1.5" opacity=".4" />
          <circle className="star-tw" cx="1010" cy="360" r="1.6" opacity=".45" />
        </g>
        <g transform="translate(1080 140)">
          <path d="M16 -30 a31 31 0 1 0 0 60 a24 24 0 1 1 0 -60z" fill="#efe8d8" opacity=".9" />
          <circle cx="12" cy="-9" r="3" fill="#d9d0b8" opacity=".6" />
          <circle cx="-7" cy="7" r="2.3" fill="#d9d0b8" opacity=".5" />
        </g>
        <g className="cloud-drift" opacity=".8">
          <path d="M120 240 q5 -17 24 -13 q8 -12 26 -7 q20 -4 24 9 q14 1 12 12 q-2 10 -17 9 h-56 q-14 1 -13 -10z" fill="#2b3454" stroke="#4a5680" strokeWidth="2.8" strokeLinejoin="round" />
        </g>
        <g className="cloud-drift-2" opacity=".7">
          <path d="M560 110 q4 -13 19 -11 q7 -9 22 -5 q16 -4 19 7 q11 1 9 9 q-1 8 -13 7 h-46 q-12 1 -10 -7z" fill="#2b3454" stroke="#4a5680" strokeWidth="2.6" strokeLinejoin="round" />
        </g>
        <path d="M-4 656 q60 -12 120 -3 q66 10 132 -3 q68 -12 136 0 q72 12 142 1 q66 -10 132 2 q66 12 134 3 q62 -8 128 1 q66 8 132 0 l0 148 -1284 0 z" fill="#221f1a" />
        <path d="M-4 656 q60 -12 120 -3 q66 10 132 -3 q68 -12 136 0 q72 12 142 1 q66 -10 132 2 q66 12 134 3 q62 -8 128 1 q66 8 132 0" stroke="#d99a30" strokeWidth="2.8" fill="none" opacity=".45" />
        <g stroke="#5c7a46" strokeWidth="3" strokeLinecap="round" fill="none" opacity=".85">
          <path d="M80 692 q3 -14 8 -1 M93 692 q3 -17 9 -2 M106 692 q2 -11 6 -1" />
          <path d="M420 684 q3 -13 7 -1 M432 684 q2 -16 8 -2" />
          <path d="M760 700 q3 -14 8 -1 M773 700 q3 -16 9 -2 M786 700 q2 -10 6 -1" />
          <path d="M1120 690 q3 -12 7 -1 M1132 690 q2 -15 8 -2" />
          <path d="M250 736 q3 -12 7 -1 M262 736 q2 -14 8 -2" />
        </g>
        <circle cx="500" cy="712" r="3" fill="#e05a6a" opacity=".5" />
        <circle cx="920" cy="706" r="2.6" fill="#e05a6a" opacity=".4" />
        <g className="chick-bob" transform="translate(560 652) scale(1.3) rotate(-4 32 34)">
          <path d="M27 18.8 l2.4 -5.8 3 5.2" stroke="#d99a30" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M34.5 18.6 l3.4 -5.6 1.6 6" stroke="#d99a30" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" fill="#e9d489" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" stroke="#d99a30" strokeWidth="2.2" fill="none" />
          <path d="M13.5 38 q-4.5 1.5 -3 5.5 q1.5 3.5 5.5 3" stroke="#d99a30" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" stroke="#d99a30" strokeWidth="2" strokeLinecap="round" fill="none" />
          <ellipse cx="26.8" cy="31.2" rx="2.2" ry="2.7" fill="#3a3020" />
          <circle cx="27.6" cy="30.2" r=".85" fill="#fff" opacity=".8" />
          <circle cx="26" cy="32.4" r=".45" fill="#fff" opacity=".55" />
          <ellipse cx="37.2" cy="31.2" rx="2.2" ry="2.7" fill="#3a3020" />
          <circle cx="38" cy="30.2" r=".85" fill="#fff" opacity=".8" />
          <circle cx="36.4" cy="32.4" r=".45" fill="#fff" opacity=".55" />
          <ellipse cx="20.8" cy="36.5" rx="3.9" ry="2.5" fill="#d98f7e" />
          <ellipse cx="43.2" cy="36.5" rx="3.9" ry="2.5" fill="#d98f7e" />
          <path d="M29.7 35.4 q2.4 -2 4.7 0 q-.85 2.5 -2.35 2.5 q-1.5 0 -2.35 -2.5 z" fill="#e8825c" />
          <path d="M13.5 44 q4.7 -4.2 9.6 0 q4.9 4.2 9.7 0 q4.7 -4.2 9.6 0 q4.8 4.2 9.6 0 l-.4 6.5 q-.5 6.5 -7.5 6.5 h-22.8 q-7 0 -7.5 -6.5 z" fill="#efe8d8" stroke="#d99a30" strokeWidth="2.2" strokeLinejoin="round" />
          <circle cx="26" cy="52" r="1.5" fill="#d98f7e" opacity=".8" />
          <circle cx="37" cy="54" r="1.2" fill="#9fc3e0" opacity=".5" />
          {/* 灯笼: 挂翅尖下照亮蛋壳,两圈金环做柔光,无滤镜(深色下浏览器 filter 性能不可控) */}
          <circle cx="51" cy="51" r="13" fill="#e8b03c" opacity=".14" />
          <circle cx="51" cy="51" r="8" fill="#e8b03c" opacity=".22" />
          <circle cx="51" cy="51" r="4.5" fill="#ffdf8e" opacity=".9" />
          <path d="M47 45.5 q4 -5 8 0" stroke="#d99a30" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </g>
        <g className="chick-bob-2" transform="translate(940 690) scale(1.05) rotate(5 32 34)">
          <path d="M27 18.8 l2.4 -5.8 3 5.2" stroke="#d99a30" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M34.5 18.6 l3.4 -5.6 1.6 6" stroke="#d99a30" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" fill="#e9d489" />
          <ellipse cx="32" cy="34" rx="18.5" ry="15.5" stroke="#d99a30" strokeWidth="2.2" fill="none" />
          <path d="M13.5 38 q-4.5 1.5 -3 5.5 q1.5 3.5 5.5 3" stroke="#d99a30" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" stroke="#d99a30" strokeWidth="2" strokeLinecap="round" fill="none" />
          <ellipse cx="26.8" cy="31.2" rx="2.2" ry="2.7" fill="#3a3020" />
          <circle cx="27.6" cy="30.2" r=".85" fill="#fff" opacity=".8" />
          <circle cx="26" cy="32.4" r=".45" fill="#fff" opacity=".55" />
          <ellipse cx="37.2" cy="31.2" rx="2.2" ry="2.7" fill="#3a3020" />
          <circle cx="38" cy="30.2" r=".85" fill="#fff" opacity=".8" />
          <circle cx="36.4" cy="32.4" r=".45" fill="#fff" opacity=".55" />
          <ellipse cx="20.8" cy="36.5" rx="3.9" ry="2.5" fill="#d98f7e" />
          <ellipse cx="43.2" cy="36.5" rx="3.9" ry="2.5" fill="#d98f7e" />
          <path d="M29.7 35.4 q2.4 -2 4.7 0 q-.85 2.5 -2.35 2.5 q-1.5 0 -2.35 -2.5 z" fill="#e8825c" />
          <path d="M13.5 44 q4.7 -4.2 9.6 0 q4.9 4.2 9.7 0 q4.7 -4.2 9.6 0 q4.8 4.2 9.6 0 l-.4 6.5 q-.5 6.5 -7.5 6.5 h-22.8 q-7 0 -7.5 -6.5 z" fill="#efe8d8" stroke="#d99a30" strokeWidth="2.2" strokeLinejoin="round" />
          <circle cx="26" cy="52" r="1.5" fill="#d98f7e" opacity=".8" />
          <circle cx="37" cy="54" r="1.2" fill="#9fc3e0" opacity=".5" />
        </g>
      </svg>
    </>
  )
}
