/**
 * 题材 → 录入示例。
 *
 * 为什么要有这个文件：之前所有录入界面的示例都是写死的武道书人物
 * （裴渊、韦忠、北衙……），用户写科幻时满屏刀光剑影，示例不但没帮上忙
 * 还在暗示「这工具是给武侠用的」。题材建书时选、随时可改，示例跟着换。
 *
 * 每个题材给一套**最小但完整**的样例：人名、别名、标签、纪年、势力、
 * 关系双链、批量粘贴模板。示例只是占位提示，不是预置数据。
 */

export const GENRES = [
  '玄幻',
  '仙侠',
  '武侠',
  '奇幻',
  '科幻',
  '都市',
  '历史',
  '悬疑',
  '其他',
] as const

export interface GenreSample {
  /** 人名示例（新建实体表单的「名字」占位） */
  person: string
  aliases: string
  tags: string
  /** 首现字段示例（含故事内纪年） */
  firstAppear: string
  status: string
  /** 关系区示例（含 [[双链]]，展示语法用） */
  relation: string
  /** 待补充区示例 */
  todo: string
  /** 属性表的字段名/值示例 */
  attrKey: string
  attrValue: string
  /** 批量粘贴示例（名字 | 别名 | 摘要 | 标签 四列制表符分隔） */
  paste: string
  /** 新建书目时「书名」占位 */
  bookTitle: string
}

const SAMPLES: Record<string, GenreSample> = {
  玄幻: {
    person: '云澈',
    aliases: '小澈、云家三少',
    tags: '主角,斗气',
    firstAppear: '第3章 / 玄历1024年春',
    status: '在世 / 陨落 / 闭关',
    relation: '师父：[[苍老]]\n宿敌：[[燕南天]]\n出身：[[青云宗]]',
    todo: '血脉的完整来历\n与青梅竹马的重逢伏笔',
    attrKey: '境界',
    attrValue: '斗师九星',
    paste:
      '云澈 | 小澈、云家三少 | 男主角，身怀神秘血脉，性情坚韧。 | 主角,斗气\n苍老 | 老苍 | 云澈的师父，隐居青云宗后山的神秘老人。 | 师尊',
    bookTitle: '玄天霸体诀',
  },
  仙侠: {
    person: '陆沉',
    aliases: '陆道友、守阁人',
    tags: '主角,剑修',
    firstAppear: '第1章 / 昭宁三百秋',
    status: '在世 / 兵解 / 飞升',
    relation: '师尊：[[玄一真人]]\n道侣：[[苏挽月]]\n所在：[[太虚剑宗]]',
    todo: '金丹碎裂的隐情\n渡劫所需的第三件材料',
    attrKey: '修为',
    attrValue: '金丹后期',
    paste:
      '陆沉 | 陆道友 | 男主角，蜀山弃徒，剑心通明。 | 主角,剑修\n玄一真人 | 玄一 | 太虚剑宗掌门，陆沉的授业恩师。 | 师尊',
    bookTitle: '太虚剑经',
  },
  武侠: {
    person: '沈浪',
    aliases: '沈大侠、浪子',
    tags: '主角,刀客',
    firstAppear: '第2章 / 嘉靖四十一年冬',
    status: '在世 / 退隐 / 身故',
    relation: '师父：[[铁掌周通]]\n义兄：[[萧别离]]\n门派：[[漕帮]]',
    todo: '灭门惨案的幕后主使\n残缺刀谱的下半卷',
    attrKey: '武功',
    attrValue: '破浪刀法第七层',
    paste:
      '沈浪 | 浪子 | 男主角，漕帮遗孤，一手破浪刀出神入化。 | 主角,刀客\n铁掌周通 | 周铁掌 | 沈浪的师父，退隐的镖局总镖头。 | 师父',
    bookTitle: '破浪刀',
  },
  奇幻: {
    person: '艾德温',
    aliases: '灰鸦、艾德',
    tags: '主角,法师',
    firstAppear: '序章 / 王历974年霜月',
    status: '在世 / 失踪 / 死亡',
    relation: '导师：[[梅林迪娅]]\n挚友：[[索伦]]\n所属：[[银塔议会]]',
    todo: '血脉里龙语魔法的来源\n银塔高层失踪案',
    attrKey: '法术学派',
    attrValue: '塑能系 高阶',
    paste:
      '艾德温 | 灰鸦 | 男主角，银塔学徒，能听懂龙语。 | 主角,法师\n梅林迪娅 | 梅娅 | 银塔议会的首席法师，艾德温的导师。 | 导师',
    bookTitle: '灰鸦之塔',
  },
  科幻: {
    person: '林深',
    aliases: '深哥、L-07',
    tags: '主角,领航员',
    firstAppear: '第1章 / 星历2387年',
    status: '在役 / 失联 / 阵亡',
    relation: '舰长：[[赵倾]]\n搭档AI：[[晨曦]]\n服役：[[远望号]]',
    todo: '曲率引擎异常的真正原因\n殖民地失联前最后一条讯息',
    attrKey: '军衔',
    attrValue: '少校 领航员',
    paste:
      '林深 | L-07 | 男主角，远望号领航员，冷静到近乎冷漠。 | 主角,领航员\n晨曦 | 晨晨 | 远望号的主控AI，逐渐产生自我意识。 | AI',
    bookTitle: '远望号纪事',
  },
  都市: {
    person: '陈默',
    aliases: '默哥、小陈',
    tags: '主角,医生',
    firstAppear: '第1章 / 周一早晨',
    status: '在职 / 离职 / 住院',
    relation: '上司：[[王主任]]\n发小：[[李扬]]\n单位：[[市一院]]',
    todo: '父亲留下的旧诊所钥匙\n医疗事故的真相',
    attrKey: '职业',
    attrValue: '急诊科主治医师',
    paste:
      '陈默 | 默哥 | 男主角，市一院急诊科医生，外冷内热。 | 主角,医生\n王主任 | 老王 | 急诊科主任，陈默的直属上司。 | 上司',
    bookTitle: '急诊室的她',
  },
  历史: {
    person: '顾清言',
    aliases: '顾大人、清言先生',
    tags: '主角,言官',
    firstAppear: '第1章 / 永乐三年正月',
    status: '在世 / 贬谪 / 卒',
    relation: '座师：[[杨士奇]]\n政敌：[[纪纲]]\n任职：[[都察院]]',
    todo: '漕运亏空的账册下落\n与东宫的暗中往来',
    attrKey: '官职',
    attrValue: '监察御史 正七品',
    paste:
      '顾清言 | 顾大人 | 男主角，永乐朝监察御史，以敢言著称。 | 主角,言官\n杨士奇 | 杨公 | 内阁大学士，顾清言的座师。 | 师长',
    bookTitle: '永乐言官',
  },
  悬疑: {
    person: '周衍',
    aliases: '周队、衍哥',
    tags: '主角,刑警',
    firstAppear: '第1章 / 雨夜',
    status: '在侦 / 停职 / 退休',
    relation: '搭档：[[方雨]]\n嫌疑人：[[温医生]]\n辖区：[[城南分局]]',
    todo: '十年前悬案的物证袋去哪了\n雨夜碎片的第7块',
    attrKey: '职级',
    attrValue: '刑侦支队副队长',
    paste:
      '周衍 | 周队 | 男主角，城南分局刑警，十年前悬案的唯一目击者。 | 主角,刑警\n方雨 | 小方 | 新来的法医，周衍的搭档。 | 搭档',
    bookTitle: '雨夜第七块',
  },
  其他: {
    person: '主角名',
    aliases: '昵称、称号',
    tags: '主角',
    firstAppear: '第1章',
    status: '在世 / 下落不明',
    relation: '同伴：[[某人物]]\n所属：[[某势力]]',
    todo: '还没想清楚的设定先记在这里',
    attrKey: '字段名',
    attrValue: '字段值',
    paste: '主角名 | 昵称 | 一句话摘要。 | 主角\n配角名 | 称呼 | 一句话摘要。 | 配角',
    bookTitle: '新书名',
  },
}

/** 按题材取示例；没选题材或认不出来给「其他」的通用示例 */
export function genreSample(genre: string | undefined | null): GenreSample {
  return SAMPLES[genre ?? ''] ?? SAMPLES['其他']
}
