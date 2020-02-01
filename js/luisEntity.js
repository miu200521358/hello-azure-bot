
// 自作ライブラリ
var utils = require('./utils.js');

// 時刻用
var moment = require('moment-timezone');

// DB
var NeDB = require('nedb');
var db = {};

// 県情報DB
db.dept = new NeDB({
    // 読み込みはapp.jsから相対？
    filename: './db/dept.db'
});
db.dept.loadDatabase();

// メッセージリスト
var messages = require('../json/message.json');

// LUIS解析結果
var LuisEntity = function() {
    this.message = [];
    this.entities = [];
    
    this.dialog = "";
    this.isActionGo = false;
    this.isActionTouch = false;
    this.isActionEat = false;
    this.isActionSee = false;
    this.isActionEnjoy = false;
    this.isActionClimb = false;
    this.isActionHear = false;
    this.isActionHeal = false;
    this.isActionSwim = false;
    this.isActionHear = false;
    this.isActionKnow = false;
    this.isDayToday = false;
    this.isDayTomorrow = false;
    this.isDemandExperienced = false;
    this.isDemandWant = false;
    this.isInfoTime = false;
    this.isInfoNow = false;
    this.isInfoWeather = false;
    this.isInfoMap = false;
    this.isMonthRelativeThis = false;
    this.isMonthRelativeNext = false;
    this.isMonthRelativeAfterNext = false;
    this.isYearRelativeThis = false;
    this.isYearRelativeNext = false;
    
    this.year = null;
    this.month = null;    
    
    this.period = [];
    this.price = [];
    this.range = [];
    this.spot = [];

    // キーワード
    this.keyword = [];

    // 出発地点情報
    this.dept = null;
    
    // 出発月
    this.yyyymm = null;
}

LuisEntity.prototype.getKeywordRegExp = function(){
    return new RegExp(/(が|を|に|へ|と|より|から|で|や|より|経由で|、|。|\s|　)/g);
}

LuisEntity.prototype.set = function(builder, args, message) {
    console.log("LuisEntity set開始: message %s", message);
    console.log(args);

    // エンティティをstartIndexの昇順で並べ替える
    args.intent.entities.sort(function(a,b){
        // console.log("a.startIndex: %i / b.startIndex: %i", a.startIndex, b.startIndex);
        if(a.startIndex < b.startIndex) return -1;
        if(a.startIndex > b.startIndex) return 1;
        return 0;
    });

    console.log(args.intent.entities);
    
    // 後で追加も可能性としてあるので、setで対応する
    this.message.push(message);
    this.entities.push(args.intent.entities);

    this.dialog = messages.want_go.code;

    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::go')) {
        this.isActionGo = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::touch')) {
        this.isActionTouch = true;
        this.keyword.push("体験");
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::eat')) {
        this.isActionEat = true;
        this.keyword.push("食");
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::see')) {
        this.isActionSee = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::enjoy')) {
        this.isActionEnjoy = true;
        this.keyword.push("楽し");
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::climb')) {
        this.isActionClimb = true;
        this.keyword.push("登");
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::hear')) {
        this.isActionHear = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::heal')) {
        this.isActionHeal = true;
        this.keyword.push("癒");
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::swim')) {
        this.isActionSwim = true;
        this.keyword.push("泳");
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'action::know')) {
        this.isActionKnow = true;
        // 「知る」は「知る」ダイアログに遷移
        this.dialog = messages.want_know.code;
    }

    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'day::today')) {
        this.isDayToday = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'day::tomorrow')) {
        this.isDayTomorrow = true;
    }

    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'demand::experienced')) {
        this.isDemandExperienced = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'demand::want')) {
        this.isDemandWant = true;
    }

    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'info::time')) {
        this.isInfoTime = true;
        this.dialog = messages.want_info.time.code;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'info::weather')) {
        this.isInfoWeather = true;
        this.dialog = messages.want_info.weather.code;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'info::map')) {
        this.isInfoMap = true;
        this.dialog = messages.want_info.map.code;
    }

    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'month_relative::this_month')) {
        this.isMonthRelativeThis = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'month_relative::next_month')) {
        this.isMonthRelativeNext = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'month_relative::after_next_month')) {
        this.isMonthRelativeAfterNext = true;
    }

    var periodEntities = builder.EntityRecognizer.findAllEntities(args.intent.entities, 'period');
    if (periodEntities) {
        // あるのは全部登録する
        for (var k of periodEntities) {
            this.period.push(k.entity);
        }
    }
    
    var priceEntities = builder.EntityRecognizer.findAllEntities(args.intent.entities, 'price');
    if (priceEntities) {
        // あるのは全部登録する
        for (var k of priceEntities) {
            this.price.push(k.entity);
        }
    }

    var rangeEntities = builder.EntityRecognizer.findAllEntities(args.intent.entities, 'range');
    if (rangeEntities) {
        // あるのは全部登録する
        for (var k of rangeEntities) {
            this.range.push(k.entity);
        }
    }

    var spotEntities = builder.EntityRecognizer.findAllEntities(args.intent.entities, 'spot');
    if (spotEntities) {
        // あるのは全部登録する
        for (var k of spotEntities) {
            this.spot.push(k.entity);
        }
    }

    // 月エンティティ
    var monthEntity = builder.EntityRecognizer.findEntity(args.intent.entities, 'month');
    if (monthEntity) {
        this.month = monthEntity.entity;
    }
    else {
        // 月がない場合、数字＋月で一応調べとく
        var monthMatch = message.match(/\d+月/);
        if (monthMatch && monthMatch.length > 0) {
            // 正規表現で月っぽい表示があった場合
            this.month = monthMatch[0].replace("月", "");
        }
    }
    
    var yearEntity = builder.EntityRecognizer.findEntity(args.intent.entities, 'year');
    if (yearEntity) {
        this.year = yearEntity.entity;
    }
    else {
        // 年がない場合、数字＋年で一応調べとく
        var yearMatch = message.match(/\d+年/);
        if (yearMatch && yearMatch.length > 0) {
            // 正規表現で年っぽい表示があった場合
            this.year = yearMatch[0].replace("年", "");
        }
    }

    if (!this.year && !this.month) {
        // 年月ともに表記がなさそうな場合、スラッシュでの区切りで探す
        var ymMatch = message.match(/\d+\/\d+/);
        if (ymMatch && ymMatch.length > 0) {
            var yms = ymMatch[0].split("/");
            this.year = yms[0];
            this.month = yms[1];
        }
    }
    
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'year_relative::this_year')) {
        this.isYearRelativeThis = true;
    }
    if (builder.EntityRecognizer.findEntity(args.intent.entities, 'year_relative::next_year')) {
        this.isYearRelativeNext = true;
    }

    // キーワード  --------------------
    // キーワードとして抽出されたエンティティはそのまま登録する
    var keywordEntities = builder.EntityRecognizer.findAllEntities(args.intent.entities, 'keyword');
    if (keywordEntities) {
        // あるのは全部登録する
        for (var k of keywordEntities) {
            this.keyword.push(k.entity);
        }
    }
    
    // エンティティ以外の部分をキーワードとして扱う
    if (this.entities[this.entities.length - 1].length > 0) {
        var startIndex = 0;
        // 最新のエンティティを扱う
        for (var entity of this.entities[this.entities.length - 1]) {
            console.log("entity", entity);
            if (startIndex < message.length && startIndex < entity.startIndex) {
                // 開始地点から、次のエンティティまでの部分を抽出する
                var msg = message.substring(startIndex, entity.startIndex);
                console.log("msg: %s", msg);
                // 助詞とかで分割する(「の」だけは分割しない)
                var msgs = msg.split(this.getKeywordRegExp());
                console.log("msgs: %s", msgs.join("/"));

                for (var m of msgs) {
                    if (m.length == 1 && isKanji(m)) {
                        // 漢字1文字ならキーワードとする
                        console.log("漢字1文字: %s", m);
                        this.keyword.push(m);
                    }
                    else if (m.length > 1 && !m.match(this.getKeywordRegExp())) {
                        // それ以外は2文字以上繋がっていること
                        // 分割対象文字列にヒットしないこと
                        console.log("それ以外2文字以上: %s", m);
                        this.keyword.push(m);
                    }
                }
            }
            else {
                console.log("startIndex: %i", startIndex);
                console.log("message.length: %i", message.length);
                console.log("entity.startIndex: %i", entity.startIndex);
            }
            // 開始地点移動
            startIndex = entity.endIndex + 1;
        }
    }
    else {
        // エンティティがない場合、全文分解
        this.analyzeKeyword(message);
    }

    console.log("keyword: %s", this.keyword.join("/"));
    
    // 年月算出 --------------------
    var nowMoment = moment();
    var calcMonth = -1;
    var calcYear = -1;

    if (this.isYearRelativeThis) {
        // 今年指定があった場合
        calcYear = nowMoment.year();
    }
    else if (this.isYearRelativeNext) {
        // 来年指定があった場合
        calcYear = nowMoment.year() + 1;
    }

    if (this.year) {
        // 年の指定がある場合
        calcYear = toHankaku(this.year.replace("年", ""));
    }

    if (this.isMonthRelativeThis) {
        // 今月指定があった場合
        calcMonth = nowMoment.month();
    }
    else if (this.isMonthRelativeNext) {
        // 来月指定があった場合
        calcMonth = nowMoment.month() + 1;
    }
    else if (this.isMonthRelativeAfterNextNext) {
        // 再来月指定があった場合
        calcMonth = nowMoment.month() + 2;
    }

    if (this.month) {
        // 月の指定がある場合
        // 数値化して、-1しておく
        calcMonth = eval(toHankaku(this.month.replace("月", ""))) - 1;
    }

    console.log("calcYear: %s, calcMonth: %s", calcYear, calcMonth);

    if (calcYear >= 0 || calcMonth >= 0) {
        if (calcYear < 0) {
            // 年がまだ指定されていない場合、今年
            calcYear = nowMoment.year();
        }
        if (calcMonth < 0) {
            // 月がまだ指定されていない場合、今月
            calcMonth = nowMoment.month();
        }

        console.log("calcYear: %s, calcMonth: %s", calcYear, calcMonth);
        
        // 計算年月で算出
        this.yyyymm = moment(new Date(calcYear, calcMonth, 1)).format("YYYYMM");
    }
    else {
        this.yyyymm = null;
    }

    console.log("yyyymm: %s", this.yyyymm);
    
}

LuisEntity.prototype.analyzeKeyword = function(msg) {
    console.log("msg: %s", msg);
    // 助詞とかで分割する(「の」だけは分割しない)
    var msgs = msg.split(this.getKeywordRegExp());
    console.log("msgs: %s", msgs.join("/"));

    for (var m of msgs) {
        if (m.length == 1 && isKanji(m)) {
            // 漢字1文字ならキーワードとする
            console.log("漢字1文字: %s", m);
            this.keyword.push(m);
        }
        else if (m.length > 1 && !m.match(this.getKeywordRegExp())) {
            // それ以外は2文字以上繋がっていること
            // 分割対象文字列にヒットしないこと
            console.log("それ以外2文字以上: %s", m);
            this.keyword.push(m);
        }
    }
}

LuisEntity.prototype.getDept = function(callback) {
    console.log("this.keyword");
    console.log(this.keyword);
    var keywords = this.keyword;
    var result;

    //　非同期のループ
    utils.asyncLoop(keywords.length, function(loop){
        // 出発地点の検索
        searchDept(keywords[loop.iteration()], function(doc, next){
            if (doc) {
                console.log("getDept結果あり");
                console.log(doc);
                result = doc;
                // 結果があった場合、ループを抜ける
                loop.break();
            }
            loop.next();
        })
    }, function(){
        console.log("asyncLoop終了");
        console.log(result);
        // 終わったら結果を返す
        callback(result);
    });
}

function searchDept (searchText, callback, next) {
    // 都府県、空港は除く
    searchText = searchText.replace(/(都|府|県|空港)$/, '');

    console.log("searchText: "+ searchText);
    
    // 選択された県名を含む県情報を取得する
    db.dept.find({"pref": new RegExp(searchText)}, function (err, docs){
        if (err) {
            console.log(err);
            throw new Error("県情報の取得に失敗しました。");
        }
        else {
            if (docs.length > 0) {
                // エラー情報がない場合
                console.log("県情報あり");
                console.log(docs[0]);
                
                // 県情報を先頭1件だけ呼出元に戻す
                callback(docs[0], next);
            }
            else {
                // 明示的なエラーではない場合、null
                console.log("県情報なし");
                callback(null, next);
            }
        }
    });
}

// 漢字であるか否か判断
function isKanji(c){ // c:判別したい文字
    var unicode = c.charCodeAt(0);
    if ( (unicode>=0x4e00  && unicode<=0x9fcf)  || // CJK統合漢字
         (unicode>=0x3400  && unicode<=0x4dbf)  || // CJK統合漢字拡張A
         (unicode>=0x20000 && unicode<=0x2a6df) || // CJK統合漢字拡張B
         (unicode>=0xf900  && unicode<=0xfadf)  || // CJK互換漢字
         (unicode>=0x2f800 && unicode<=0x2fa1f) )  // CJK互換漢字補助
        return true;

    return false;
}

function toHankaku(str) {
    // 全角英数の文字コードから65248個前が半角英数の文字コードとなっている為、
    // 文字コードから65248引いて変換します。
    return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });    
}


module.exports = LuisEntity;