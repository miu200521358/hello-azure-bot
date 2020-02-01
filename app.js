var restify = require('restify');
var builder = require('botbuilder');
var async = require('async');

// 環境変数
require('dotenv').config();
var request = require('request');

// 自作ライブラリ
var utils = require('./js/utils.js');
var LuisEntity = require('./js/luisEntity.js');

// クラウドDB
var NCMB = require("ncmb");
// mobile backendアプリとの連携
var ncmb = new NCMB(process.env.NCMB_API_KEY, process.env.NCMB_CLIENT_KEY);
// LUIS解析結果TBLの作成
var NcmbRecognizerClass = ncmb.DataStore("RecognizerClass");
// エラーTBLの作成
var NcmbErrorClass = ncmb.DataStore("ErrorClass");
// URLリクエストTBLの作成
var NcmbUrlsClass = ncmb.DataStore("UrlsClass");
// 天気TBLの作成
var NcmbWeatherClass = ncmb.DataStore("WeatherClass");
// ツアーTBLの作成
var NcmbTourClass = ncmb.DataStore("TourClass");
// 翻訳TBLの作成
var NcmbTranslateClass = ncmb.DataStore("TranslateClass");

// DB
var NeDB = require('nedb');
var db = {};

// 国情報DB
db.country = new NeDB({
    filename: 'db/country.db'
});
db.country.loadDatabase();

// 言語情報DB
db.language = new NeDB({
    filename: 'db/language.db'
});
db.language.loadDatabase();

// 翻訳情報DB
db.dialect = new NeDB({
    filename: 'db/dialect.db'
});
db.dialect.loadDatabase();

// 発声用
var fs = require('fs');
var os = require('os');
var path = require('path');
var util = require('util');
var ffmpeg = require('fluent-ffmpeg');

// 発声クライアント
var bingSpeechApiClient = require('bingspeech-api-client');

// 時刻用
var moment = require('moment-timezone');

// メッセージリスト
var messages = require('./json/message.json');

// サーバ構築
var server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function () {
   console.log('[%s] listening to [%s]:[%s] %s', server.name, server.address().address, server.address().port, server.url); 
});

var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

server.post('/api/messages', connector.listen());

// bot構築
var bot = new builder.UniversalBot(connector, function(session){
    if (session.privateConversationData.prompt) {
        // プロンプトの場合
        console.log("from prompt");
        // console.log(session.privateConversationData.dialogStack);
        // console.log(session.sessionState.callstack);

        // 質問のあったとこの直前までスタックを追加する
        session.dialogStack(session.privateConversationData.dialogStack.slice(0, session.privateConversationData.dialogStack.length - 1));

        // 直前に実行していたダイアログを再開
        session.beginDialog(session.privateConversationData.dialogStack[session.privateConversationData.dialogStack.length - 1].id);
    }
    else {
        // 通常の場合、解析する
        if (session.message.text && session.message.text.length > 0) {
            session.beginDialog("/default");
        }
    }
});

// LUIS
var recognizer = new builder.LuisRecognizer(process.env.LUIS_MODEL_URL)
recognizer.onEnabled(function (context, callback) {
    console.log("context.dialogStack(): ")
    // console.log(context.dialogStack());
    console.log("context.privateConversationData.prompt: "+ context.privateConversationData.prompt);

    // LUIS有効FLG
    var enabled = true;

    if (context.privateConversationData.prompt && context.message.text && context.message.text.length > 0) {
        for (var opt of context.privateConversationData.promptOptions) {
            if (opt.name == context.message.text) {
                // プロンプト表示時、選択肢と入力文字列が等しい場合のみ、LUIS無効
                enabled = false;
            }
        }
    }

    // 直前のダイアログID
    if (context.privateConversationData.dialogStack && context.privateConversationData.dialogStack.length > 0) {
        var lastDialogId = context.privateConversationData.dialogStack[
            context.privateConversationData.dialogStack.length - 1].id;
        if (context.privateConversationData.prompt && lastDialogId == '/condition') {
            // 条件入力の場合、強制的にLUIS無効
            enabled = false;
        }
    }

    console.log("recognizer.onEnabled %s", enabled);

    callback(null, enabled);
}).onFilter(function(context, result, callback){
    console.log("result");
    console.log(result);
    console.log("context.message.text: %s", context.message.text);
    
    if (context.message.text && context.message.text.length > 0) {
        // データストアへの登録
        var ncmbRecognizerClass = new NcmbRecognizerClass();
        try {
            ncmbRecognizerClass
                .set('user_id', context.message.user.id)
                .set('user_name', context.message.user.name)
                .set('message', context.message.text)
                .set('intent', result.intent)
                .set('score', result.score)
                .set('timestamp', ''+ context.localTimestamp)
                .set('sender_id', (context.message.sourceEvent.sender) ? context.message.sourceEvent.sender.id : '')
                .set('page_id', (context.message.sourceEvent.recipient) ? context.message.sourceEvent.recipient.id : '')
                ;
            ncmbRecognizerClass.save().then(function(){
                console.log("○ NcmbRecognizerClass 登録成功");
            }).catch(function(err){
                console.log("× NcmbRecognizerClass 登録失敗");
            });
        } catch (error) {
            console.log(error);            
        }
    }
            
    if (result.intent == 'Help' && result.score > 0.7) {
        // 最上位マッチのスコアが条件を満たす場合のみ、各インテント実行
        // ヘルプは絞る
        callback(null, result);
    }
    else if (result.intent == 'WantGo' && result.score > 0.2) {
        // 最上位マッチのスコアが条件を満たす場合のみ、各インテント実行
        // 行きたい系は広げる
        callback(null, result);
    }
    else{
        if (result.score > 0.5) {
            // 最上位マッチのスコアが条件を満たす場合のみ、各インテント実行
            callback(null, result);
        }
        else {
            // 既定に満たない場合、スコア0で投げてヒットさせないようにする
            callback(null, { score: 0.0, intent: null })
        }
    }
});
bot.recognizer(recognizer);

// エラーが起きた場合、とりあえずログに出す
bot.on('error', function (e) {
    console.log('!And error ocurred', e);

    // エラーだけ登録する
    saveError(e, '!And error ocurred', null);
});

// 非同期内のエラー
process.on('unhandledRejection', error => {
    // Will print "unhandledRejection err is not defined"
    console.log('!unhandledRejection', error.message);

    // エラーだけ登録する
    saveError(error, '!unhandledRejection', null);
});

// 古い会話は一旦削除
bot.use({
    botbuilder: function (session, next) {
        console.log(session.message);
        if (session.message.text && session.message.text.length > 0) {
            // なんか入力があったら返答待ち
            session.sendTyping();
        }
        
        if (session.privateConversationData.previousAccess) {
            console.log("time: %i", new Date().getTime());
            console.log("previousAccess : %i", session.privateConversationData.previousAccess);
            var delta = new Date().getTime() - session.privateConversationData.previousAccess;

            // 3日間は保持
            if (delta > 3 * 24 * 60 * 60 * 100) {
                session.clearDialogStack();
                // データ初期化
                initialize(session);
                // ようこそメッセージ再表示
                bot.send(new builder.Message()
                    .address(session.message.address)
                    .text(messages.welcome));
            }
        }
        session.privateConversationData.previousAccess = session.sessionState.lastAccess;
        next();
    }
});

// セッションデータ初期化
function initialize(session) {
    console.log("セッションデータ初期化");
    // LUIS解析結果
    session.privateConversationData.luisEntity = null;
    // 場所検索結果
    session.privateConversationData.country = null;
    session.privateConversationData.city = null;
    session.privateConversationData.spot = null;
    session.privateConversationData.hotel = null;
    // 選択肢条件
    session.privateConversationData.promptOptions = null;
    session.privateConversationData.prompt = false;
    // 翻訳情報
    session.privateConversationData.inputText = "";
    session.privateConversationData.translatedText = "";
    session.privateConversationData.languageDoc = null;
    session.privateConversationData.dialectDocs = null;
    session.privateConversationData.dialectCountry = null;
    // 地図拡大サイズ(初期値設定済み)
    session.privateConversationData.mapZoomSize = 5;
}

// 会話開始時
bot.on('conversationUpdate', function (message) {
    if (message.membersAdded) {
        message.membersAdded.forEach(function (identity) {
            if (identity.id === message.address.bot.id) {
                bot.send(new builder.Message()
                    .address(message.address)
                    .text(messages.welcome));

                // 会話開始
                bot.beginDialog(message.address, '/');
            }
        });
    }
});

// 使い方説明
bot.dialog('/help', [
    function (session, args) {
        console.log('** help');

        // データ初期化
        initialize(session);
        
        for (var msg of messages.howto) {
            session.send(msg);
        }

        session.endDialog();
    }
]).triggerAction({
    matches: 'Help'
});

// クリア
bot.dialog('/clear', [
    function (session, args) {
        console.log('** clear');

        session.send("内部情報をクリアします。（画面上は変わりません）");

        session.clearDialogStack();
        
        // データ初期化
        initialize(session);

        // ようこそメッセージ再表示
        session.send(messages.welcome);
    }
]).triggerAction({
    matches: 'Clear'
});

// 行ったことがある系
bot.dialog('/experiencedGo', [
    function (session, args) {
        console.log('** ExperiencedGo');

        // データ初期化
        initialize(session);
                   
        // 行ったことがある系はいいね絵文字で終了
        session.send('\uD83D\uDC4D');
        session.endDialog();
    }
]).triggerAction({
    matches: 'ExperiencedGo'
});


// デフォルト
bot.dialog('/default', [
    function (session, args, next) {
        console.log('** default');

        // データ初期化
        initialize(session);

        // キーワードの分析だけ行う
        var luisEntity = new LuisEntity();
        luisEntity.analyzeKeyword(session.message.text);

        if (!utils.isLuisCondition(luisEntity)) {
            // キーワードがなかった場合、エラー終了
            session.send("キーワードの特定ができませんでした。\n\n"+ messages.error_to_others);
            session.endDialog();
        }
        else {
            // エンティティを保持
            session.privateConversationData.luisEntity = luisEntity;

            session.beginDialog('/place');
        }
    }, function (session, args, next) {
        // 場所特定結果
        console.log("args");
        console.log(args);
        if (session.privateConversationData.country 
            || session.privateConversationData.city 
            || session.privateConversationData.spot) {
            // 結果があった場合、次処理
            // FIXME アクションが指定されていない場合は確認する
            session.beginDialog("/tour");
        }
        else {
            // 結果がなかった場合、翻訳処理
            console.log(">> translate");
            session.beginDialog("/translate");
        }
    }
]);

// 行ってみたい系
bot.dialog('/wantGo', [
    function (session, args, next) {
        console.log('** wantGo');

        // データ初期化
        initialize(session);        
            
        // 解析結果を設定
        var luisEntity = new LuisEntity();
        luisEntity.set(builder, args, session.message.text);

        if (!utils.isLuisCondition(luisEntity)) {
            // キーワードがなかった場合、エラー終了
            session.send("条件の特定ができませんでした。\n\n"+ messages.error_to_others);
            session.endDialog();
        }
        else {
            // 出発地点の取得は非同期なので、別途呼び出す
            luisEntity.getDept(function(dept){
                console.log("dept");
                console.log(dept);
                if (dept) {
                    // 出発地点を設定する
                    luisEntity.dept = dept;
                }
                // エンティティを保持
                session.privateConversationData.luisEntity = luisEntity;

                console.log(session.privateConversationData.luisEntity);
                
                session.beginDialog('/place');
            });
        }
    }, function (session, args, next) {
        // 場所特定結果
        console.log("args");
        console.log(args);
        if (session.privateConversationData.country 
            || session.privateConversationData.city 
            || session.privateConversationData.spot) {
            // 結果があった場合、次処理
            next(null, session, args);            
        }
        else {
            // 結果がなかった場合、エラー終了
            session.send("条件の特定ができませんでした。\n\n"+ messages.error_to_others);
            session.endDialog();
        }
    }, function(session, args) {
        console.log("session.privateConversationData.luisEntity")
        console.log(session.privateConversationData.luisEntity);
        console.log("session.privateConversationData.country");
        console.log(session.privateConversationData.country);
        console.log("session.privateConversationData.city");
        console.log(session.privateConversationData.city);
        console.log("session.privateConversationData.spot");
        console.log(session.privateConversationData.spot);

        // 動詞から推察したダイアログを開始する
        session.beginDialog(session.privateConversationData.luisEntity.dialog);
    }
]).triggerAction({
    matches: 'WantGo'
});


// 条件追加
bot.dialog('/condition', [
    function (session, args, next) {
        console.log('** condition');

        if (session.message.text == messages.option_condition[0].name) {
            // このまま進むの場合、ツアー移動
            session.beginDialog('/tour');
        }
        else {
            // 解析結果を再設定
            var luisEntity;
            if (session.privateConversationData.luisEntity) {
                luisEntity = Object.assign(new LuisEntity(), session.privateConversationData.luisEntity);
            }
            else {
                luisEntity = new LuisEntity();
            }
            luisEntity.set(builder, args, session.message.text);

            if (!utils.isLuisCondition(luisEntity)) {
                // キーワードがなかった場合、エラー終了
                session.send("場所の特定ができませんでした。\n\n"+ messages.error_to_others);
                session.endDialog();
            }
            else {
                // 出発地点の取得は非同期なので、別途呼び出す
                luisEntity.getDept(function(dept){
                    console.log("dept");
                    console.log(dept);
                    if (dept) {
                        // 出発地点を設定する
                        luisEntity.dept = dept;
                    }
                    // エンティティを保持
                    session.privateConversationData.luisEntity = luisEntity;

                    console.log(session.privateConversationData.luisEntity);
                    
                    // とりあえずツアー表示
                    // FIXME
                    session.beginDialog('/tour');
                });
            }
        }
    }
]).triggerAction({
    matches: 'Condition'
});


// 場所の特定ダイアログ
bot.dialog('/place', [
    function (session, args) {
        console.log("** place");

        session.beginDialog('/place_country');
    },
    function (session, results) {
        console.log("国検索結果");
        console.log(results);
        // 国検索結果
        if (results.code) {
            session.send("国 ["+ session.privateConversationData.country.name + "] で調べます。");
            
            // 国検索結果があった場合、そのまま終了
            session.endDialogWithResult(results);
        }
        else {
            // 国検索結果がなかった場合
            console.log("国検索結果なし");
            // 都市検索
            session.beginDialog('/place_city');
        }
    },
    function (session, results) {
        console.log("都市検索結果");
        console.log(results);
        // 都市検索結果
        if (results.code) {
            // 都市検索結果があった場合、国情報を再設定して、そのまま終了
            session.privateConversationData.country = session.privateConversationData.city.country;
            
            // カードを表示
            session.send("国 ["+ session.privateConversationData.country.name + "]\n\n"+
                        "都市 ["+ session.privateConversationData.city.name +"] で調べます");
            
            session.endDialogWithResult(results);
        }
        else {
            // 都市検索結果がなかった場合
            console.log("都市検索結果なし");
            // 観光地検索
            session.beginDialog('/place_spot');
        }
    },
    function (session, results) {
        console.log("観光地検索結果");
        console.log(results);
        // 観光地検索結果
        if (results.code) {
            // 観光地検索結果があった場合、国・都市情報を再設定して、そのまま終了
            session.privateConversationData.country = session.privateConversationData.spot.country;
            session.privateConversationData.city = session.privateConversationData.spot.city;

            // 観光地情報を表示する

            // カードを表示
            var card = new builder.HeroCard(session)
                    .title(session.privateConversationData.spot.name)
                    .subtitle(session.privateConversationData.spot.title)
                    .text(
                        session.privateConversationData.spot.city.name
                        + " (" +
                        session.privateConversationData.spot.country.name
                        + ")\n\n" +
                        session.privateConversationData.spot.description)
                    .buttons([
                        builder.CardAction.openUrl(session, session.privateConversationData.spot.url, '詳しく見る')
                    ]);
            session.send(new builder.Message(session).addAttachment(card));

            session.endDialogWithResult(results);
        }
        else {
            // 都市検索結果がなかった場合
            console.log("観光地検索結果なし");
            // 検索結果なしで返す
            session.endDialogWithResult(null);
        }
    }
]);

bot.dialog('/place_country', [
    function (session) {
        console.log("** place_country");

        // 選択された国名を含む国情報を取得する
        try {
            searchCountry(session, session.privateConversationData.luisEntity.keyword.join(" "), function(results){
                if (!results) {
                    console.log("国情報なし");
                    session.endDialogWithResult(null);
                }
                else {
                    if (results.length == 1) {
                        console.log("国情報1件確定");
                        console.log(results[0]);
                        session.privateConversationData.country = results[0];
                        session.endDialogWithResult(session.privateConversationData.country);
                    }
                    else {
                        session.privateConversationData.promptOptions = results;
                        session.beginDialog('/prompt_country');
                    }
                }
            });
        } catch (error) {
            console.log(error);
            session.send(error.message + "\n\n"+ messages.error_to_others);
            saveError(error, null, session);
            session.endDialog();
        }
    }
]);

// 国情報の検索
function searchCountry(session, searchText, callback){
    console.log("国情報取得");
    console.log(searchText);

    // 選択された国名を含む国情報を取得する
    db.country.find({"name": searchText}, function (err, docs){
        if (err) {
            console.log(err);
            var errMsg = "国情報の取得に失敗しました。";
            saveError(err, errMsg, session);            
            throw new Error(errMsg);
        }
        else {
            if (docs.length > 0) {
                // エラー情報がない場合
                console.log(docs);
                // 国情報全部を返す
                callback(docs);
            }
            else {
                // 明示的なエラーではない場合
                if (utils.isType('RegExp', searchText)) {
                    // 正規表現で検索しても見つからない場合、null
                    console.log("正規表現で検索しても見つからない");
                    console.log(searchText);
                    callback(null);
                }
                else if (utils.isType('String', searchText)) {
                    // 通常文字列の場合、一旦正規表現で検索してみる
                    console.log("通常文字列で検索結果なし %s", searchText);
                    searchCountry(session, new RegExp(searchText), callback);
                }
                else {
                    // 型がおかしい場合、null
                    callback(null);
                }
            }
        }
    });
}

// 国検索結果が複数件ある場合
bot.dialog('/prompt_country', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_country");
            console.log(session.privateConversationData.promptOptions);
    
            // 国名を選択肢とする
            var options = [];
            for (var opt of session.privateConversationData.promptOptions) {
                options.push(opt.name);
            }
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();
            
            // ボタンスタイルで表示する
            // 再度確認はしない
            builder.Prompts.choice(session
                , messages.prompt_multi
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});            
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_country やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 国の選択があった場合
            console.log(results.response);

            for (var opt of session.privateConversationData.promptOptions) {
                if (opt.name == results.response.entity) {
                    console.log("prompt_country 確定");
                    console.log(opt);

                    session.privateConversationData.country = opt;
                    session.endDialogWithResult(session.privateConversationData.country);
                }
            }
        }        
    }
]);


bot.dialog('/place_city', [
    function (session) {
        console.log("** place_city");

        // 選択された都市名を含む都市情報を取得する
        try {
            searchCity(session, session.privateConversationData.luisEntity.keyword.join(" "), function(results){
                if (!results) {
                    console.log("都市情報なし");
                    session.endDialogWithResult(null);
                }
                else {
                    console.log("都市情報あり");
                    console.log(results);
        
                    if (results.length == 1) {
                        console.log("都市情報1件確定");
                        console.log(results[0]);
                        session.privateConversationData.city = results[0];

                        // 緯度経度確認
                        searchCityLatLon(session, function(){
                            session.endDialogWithResult(session.privateConversationData.city);
                        });
                    }
                    else {
                        session.privateConversationData.promptOptions = results;
                        session.beginDialog('/prompt_city');
                    }
                }
            });
        } catch (error) {
            console.log(error);
            session.send(error.message + "\n\n"+ messages.error_to_others);
            saveError(error, null, session);
            session.endDialog();
        }
    }
]);

// 都市検索
function searchCity(session, searchText, callback) {
    console.log("都市情報取得: "+ searchText);
    
    var qsOptions = {
        'key': process.env.AB_ROAD_API_KEY,
        'in_use': 0,
        'format': 'json'
    };
    
    // 国情報がある場合、コードを設定する
    if (session.privateConversationData.country) {
        qsOptions['country'] = session.privateConversationData.country.code;
    }
    
    // 都市名がある場合、設定する
    if (searchText) {
        // カッコで読みがある場合があるので、除去する
        searchText = searchText.replace(/(（|\().*$/, '');
        qsOptions['keyword'] = searchText;
    }

    var urls = {
        url: process.env.AB_ROAD_CITY_URI,
        qs: qsOptions,
        method: 'GET'
    };

    console.log(urls);
    saveUrls(session, urls);
    
    //リクエスト送信
    request(urls, function (err, response, body) {
        if(!err && response.statusCode == 200) {
            var json = JSON.parse(body);

            console.log("AB都市情報");
            console.log(json);

            if (json.results.city && json.results.city.length > 0) {
                var searchedCities = [];
                for (var city of json.results.city) {
                    // カッコ以下は除去する
                    city.name = city.name.replace(/(（|\().*$/, '');
                    if (!searchText || city.name == searchText) {
                        // 検索対象都市名が指定されていないか、
                        // 都市名が指定されている場合は一致した都市のみ追加
                        searchedCities.push(city);
                    }
                }

                // エラー情報がない場合
                console.log(json.results.city);
                if (searchedCities.length == 1) {
                    // 全く一致した都市名だけピックアップする
                    callback(searchedCities);                    
                }
                else if (searchedCities.length > 1) {
                    if (!searchText) {
                        console.log("検索対象都市名が指定されていない場合、全件返す");
                        // 検索対象都市名が指定されていない場合、
                        // 全件返す
                        callback(searchedCities);
                    }
                    else {
                        console.log("検索対象都市名が指定されている場合、ツアー降順先頭");
                        // ツアー件数が一番多いのを暫定設定する
                        searchedCities.sort(function(a,b){
                            console.log("a: %s(%i), b: %s(%i)", a.name, a.tour_count, b.name, b.tour_count);
                            if(eval(a.tour_count) > eval(b.tour_count)) return -1;
                            if(eval(a.tour_count) < eval(b.tour_count)) return 1;
                            return 0;
                        });
                        // 降順先頭のものを返す
                        callback([searchedCities[0]]);
                    }
                }
                else {
                    // 一致した都市名がない場合、null
                    callback(null);
                }
            }
            else {
                // 明示的なエラーではない場合、null
                callback(null);
            }
        }
        else {
            console.log(err);
            var errMsg = "都市情報の取得に失敗しました。";
            saveError(err, errMsg, session);            
            throw new Error(errMsg);
        }
    });         
};

// 緯度経度
function searchCityLatLon(session, callback) {
    console.log("都市の緯度経度");
    console.log(session.privateConversationData.city);

    if (session.privateConversationData.city.lat.length > 0
        && session.privateConversationData.city.lng.length > 0) {
            session.privateConversationData.city.lat = eval(session.privateConversationData.city.lat);
            session.privateConversationData.city.lng = eval(session.privateConversationData.city.lng);
            // 既に緯度経度が入っている場合、終了
            callback();
    }
    else {
        // 緯度経度はとりあえずダミー
        session.privateConversationData.city.lat = messages.invalid_lat;
        session.privateConversationData.city.lng = messages.invalid_lat;

        var urls = {
            url: process.env.BING_MAPS_LOCATION_URI,
            qs: {
                'key': process.env.BING_MAPS_API_KEY,
                'countryRegion': session.privateConversationData.city.country.code,
                'adminDistrict': session.privateConversationData.city.name
            },
            method: 'GET'
        };

        console.log(urls);
        saveUrls(session, urls);

        //リクエスト送信
        request(urls, function (err, response, body) {
            if (err) {
                saveError(err, null, session);
                throw e;
            }
            else {
                if(response.statusCode == 200) {
                    var json = JSON.parse(body);

                    console.log(json);
                    
                    if (json.resourceSets && json.resourceSets.length > 0 && json.resourceSets[0].resources.length > 0) {
                        // 検索結果があった場合、1件目の緯度経度を取得
                        session.privateConversationData.city.lat = json.resourceSets[0].resources[0].point.coordinates[0];
                        session.privateConversationData.city.lng = json.resourceSets[0].resources[0].point.coordinates[1];
                        
                        console.log("緯度経度再取得成功");
                        console.log(session.privateConversationData.city);

                        callback();
                    }
                    else {
                        throw new Error("位置情報の取得に失敗しました。"+ messages.error_to_others);
                    }
                } else {
                    throw new Error("位置情報の取得に失敗しました。"+ messages.error_to_others +" status="+ response.statusCode);
                }
            }
        });
    }
}


// 都市検索結果が複数件ある場合
bot.dialog('/prompt_city', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_city");
            console.log(session.privateConversationData.promptOptions);
    
            // 都市名を選択肢とする
            var options = [];
            for (var opt of session.privateConversationData.promptOptions) {
                options.push(opt.name + " ("+ opt.country.name +")");
            }
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();
            
            // ボタンスタイルで表示する
            // 再度確認はしない
            builder.Prompts.choice(session
                , messages.prompt_multi
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});            
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_city やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 都市の選択があった場合
            console.log(results.response);

            for (var opt of session.privateConversationData.promptOptions) {
                if ((opt.name + " ("+ opt.country.name +")") == results.response.entity) {
                    console.log("prompt_city 確定");
                    console.log(opt);

                    session.privateConversationData.city = opt;

                    // 緯度経度確認
                    searchCityLatLon(session, function(){
                        session.endDialogWithResult(session.privateConversationData.city);
                    });
                }
            }
        }        
    }
]);



bot.dialog('/place_spot', [
    function (session) {
        console.log("** place_spot");

        // 選択された観光地名を含む観光地情報を取得する
        try {
            searchSpot(session, session.privateConversationData.luisEntity.keyword.join(" "), function(results){
                if (!results) {
                    console.log("観光地情報なし");
                    session.endDialogWithResult(null);
                }
                else {
                    console.log("観光地情報あり");
                    console.log(results);
        
                    if (results.length == 1) {
                        console.log("観光地情報1件確定");
                        console.log(results[0]);
                        session.privateConversationData.spot = results[0];
                        session.endDialogWithResult(session.privateConversationData.spot);
                    }
                    else {
                        // 観光地は最大ランダム9件
                        session.privateConversationData.promptOptions = utils.randomArray(results, 9);
                        session.beginDialog('/prompt_spot');
                    }
                }
            });
        } catch (error) {
            console.log(error);            
            session.send(error.message + "\n\n"+ messages.error_to_others);
            saveError(error, null, session);
            session.endDialog();
        }
    }
]);

// 観光地検索
function searchSpot(session, searchText, callback) {
    console.log("観光地情報取得: "+ searchText);
    
    var qsOptions = {
        'key': process.env.AB_ROAD_API_KEY,
        'keyword': searchText,
        'count': 100,
        'in_use': 0,
        'format': 'json'
    };
    
    // 国情報がある場合、コードを設定する
    if (session.privateConversationData.country) {
        qsOptions['country'] = session.privateConversationData.country.code;
    }

    // 都市情報がある場合、コードを設定する
    if (session.privateConversationData.city) {
        qsOptions['city'] = session.privateConversationData.city.code;
    }

    var urls = {
        url: process.env.AB_ROAD_SPOT_URI,
        qs: qsOptions,
        method: 'GET'
    };

    console.log(urls);
    saveUrls(session, urls);
    
    //リクエスト送信
    request(urls, function (err, response, body) {
        if(!err && response.statusCode == 200) {
            var json = JSON.parse(body);

            console.log("AB観光地情報");
            console.log(json);

            if (json.results.spot && json.results.spot.length > 0) {
                var searchedSpots = [];
                for (var spot of json.results.spot) {
                    if (spot.name == searchText) {
                        searchedSpots.push(spot);
                    }
                }

                if (searchedSpots.length == 1) {
                    // 全く一致した観光地名が1件だけある場合、確定
                    callback(searchedSpots);
                }
                else {
                    // エラー情報がない場合
                    console.log(json.results.spot);
                    // 都市情報全部を返す
                    callback(json.results.spot);
                }
            }
            else {
                // 明示的なエラーではない場合、null
                callback(null);
            }
        }
        else {
            console.log(err);
            var errMsg = "観光地情報の取得に失敗しました。";
            saveError(err, errMsg, session);            
            throw new Error(errMsg);
        }
    });         
};


// 観光地検索結果が複数件ある場合
bot.dialog('/prompt_spot', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_spot");
            console.log(session.privateConversationData.promptOptions);
    
            // 観光地名を選択肢とする
            var options = [];
            for (var opt of session.privateConversationData.promptOptions) {
                options.push(opt.name);
            }
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();
            
            // ボタンスタイルで表示する
            // 再度確認はしない
            builder.Prompts.choice(session
                , messages.prompt_multi
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});            
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_spot やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 観光地の選択があった場合
            console.log(results.response);

            for (var opt of session.privateConversationData.promptOptions) {
                if (opt.name == results.response.entity) {
                    console.log("prompt_spot 確定");
                    console.log(opt);

                    session.privateConversationData.spot = opt;
                    session.endDialogWithResult(session.privateConversationData.spot);
                }
            }
        }        
    }
]);

// ツアー
bot.dialog('/tour', [
    function(session) {
        console.log('** tour');

        if (!utils.isLuisCondition(session.privateConversationData.luisEntity)) {
            // 条件が何も入ってない場合のみ、条件確認ダイアログに遷移
            session.beginDialog('/prompt_condition');
        }
        else {
            session.beginDialog('/prompt_tour');
        }
    },
    function (session, results) {
        // ツアー検索
        session.beginDialog('/prompt_tour');
    }
]).triggerAction({
    matches: 'tour'
});


// 観光地情報を見る
bot.dialog('/prompt_tour', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_tour");
            console.log(session.privateConversationData.promptOptions);
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();

            // ツアー検索
            showTour(session
                , (session.privateConversationData.city)
                , (session.privateConversationData.spot)
                , (session.privateConversationData.hotel));
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_tour やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 他の情報を見るの選択があった場合
            console.log(results.response);
            
            if (results.response.entity == messages.want_other_postback.name) {
                session.beginDialog('/prompt_know');                
            }
            else {
                // なんか別の言葉入力された場合は、やり直し
                session.reset();
            }
        }        
    }
]);


// 検索条件の追加
bot.dialog('/prompt_condition', [
    function (session, args, next) {
        console.log('/prompt_condition start');
        
        // 条件オプションリストを取得
        session.privateConversationData.promptOptions = messages.option_condition;
        
        // 条件オプション名を選択肢とする
        var options = [];
        for (var opt of session.privateConversationData.promptOptions) {
            options.push(opt.name);
        }
        
        // ボタンスタイルで表示する
        // 再度確認はしない
        builder.Prompts.choice(session
            , messages.prompt_conditon
            , options
            , {listStyle: builder.ListStyle.button, maxRetries: 0});            
    }
]);

// ツアー検索
function showTour(session, isCity, isSpot, isHotel) {
    async.waterfall([
        function(next) {
            console.log("都市情報 - ツアー検索");

            var searchMsg = "【検索条件】";

            var qsOptions = {
                'key': process.env.AB_ROAD_API_KEY,
                'count': 50,
                'format': 'json'
            }

            // 保存用ツアー情報
            var tourOptions = {};

            // 国指定あり
            if (session.privateConversationData.country) {
                qsOptions['country'] = session.privateConversationData.country.code;
                searchMsg += "\n\n国: "+ session.privateConversationData.country.name;

                tourOptions['country'] = {
                    code: session.privateConversationData.country.code,
                    name: session.privateConversationData.country.name
                }
            }

            // 都市指定あり
            if (isCity && session.privateConversationData.city) {
                qsOptions['city'] = session.privateConversationData.city.code;
                searchMsg += "\n\n都市: "+ session.privateConversationData.city.name;

                tourOptions['city'] = {
                    code: session.privateConversationData.city.code,
                    name: session.privateConversationData.city.name
                }
            }

            // 出発地点指定あり
            if (session.privateConversationData.luisEntity.dept) {
                tourOptions['dept'] = [];
                
                var deptCodes = [];
                var deptNames = [];
                // 指定出発地点
                for (var d of session.privateConversationData.luisEntity.dept.dept) {
                    // 出発地点一覧
                    for (var d2 of messages.dept) {
                        // コードが等しい場合
                        if (d == d2.code) {
                            // リストに追加
                            deptCodes.push(d);
                            deptNames.push(d2.name);

                            tourOptions['dept'].push({
                                code: d,
                                name: d2.name
                            });
                        }
                    }
                }

                // 空白で結合する
                qsOptions['dept'] = deptCodes.join(" ");
                
                searchMsg += "\n\n出発地点: "+ deptNames.join("/");                
            }

            // 出発年月指定あり
            if (session.privateConversationData.luisEntity.yyyymm) {
                qsOptions['ym'] = session.privateConversationData.luisEntity.yyyymm;
                searchMsg += "\n\n出発年月: "+ session.privateConversationData.luisEntity.yyyymm;    

                tourOptions['ym'] = session.privateConversationData.luisEntity.yyyymm;        
            }

            var keywords = [];

            // 観光地指定あり
            if (isSpot && session.privateConversationData.spot) {
                keywords.push(session.privateConversationData.spot.name);
            }

            // ホテル指定あり
            if (isHotel && session.privateConversationData.hotel) {
                qsOptions['hotel'] = session.privateConversationData.hotel.code;
                searchMsg += "\n\nホテル: "+ session.privateConversationData.hotel.name;

                tourOptions['hotel'] = {
                    code: session.privateConversationData.hotel.code,
                    name: session.privateConversationData.hotel.name
                }
            }

            // キーワード指定あり
            if (session.privateConversationData.luisEntity.keyword.length > 0) {
                // 国・都市・出発地点は抜く
                var filterKeyword = session.privateConversationData.luisEntity.keyword.filter(function(v){
                    var result = true;
                    if (session.privateConversationData.country 
                        && v.indexOf(session.privateConversationData.country.name) >= 0) {
                            // 国情報で既に指定してあるワードである場合、false
                            result = false;
                    }
                    if (session.privateConversationData.city 
                        && v.indexOf(session.privateConversationData.city.name) >= 0) {
                            // 都市情報で既に指定してあるワードである場合、false
                            result = false;
                    }
                    if (session.privateConversationData.spot 
                        && v.indexOf(session.privateConversationData.spot.name) >= 0) {
                            // 観光地情報で既に指定してあるワードである場合、false
                            result = false;
                    }
                    if (session.privateConversationData.luisEntity.dept 
                        && v.indexOf(session.privateConversationData.luisEntity.dept.pref) >= 0) {
                            // 出発地点情報で既に指定してあるワードである場合、false
                            result = false;
                    }
                    return result;
                });

                Array.prototype.push.apply(keywords, filterKeyword);
            }
                
            if (keywords.length > 0) {
                // 空白で結合する
                qsOptions['keyword'] = keywords.join(" ");
                // 出力には/で結合する
                searchMsg += "\n\nキーワード: "+ keywords.join("/");       

                tourOptions['keyword'] = keywords;               
            }

            var urls = {
                url: process.env.AB_ROAD_TOUR_URI,
                qs: qsOptions,
                method: 'GET'
            };
            
            console.log(urls);
            saveUrls(session, urls);
            saveTour(session, tourOptions);
            
            // 検索条件を流す
            session.send(searchMsg);
            session.sendTyping();
            
            //リクエスト送信
            request(urls, function (err, response, body) {
                if(!err && response.statusCode == 200) {
        
                    var json = JSON.parse(body);
        
                    console.log("ABツアー情報");
                    // console.log(json);
        
                    if (json.results.tour && json.results.tour.length > 0) {
                        // 検索結果がある場合、次へ
                        next(null, json.results.tour);
                    }
                    else {
                        if (isHotel) {
                            // ホテル指定ありで、検索結果がなかった場合、除外して検索する
                            session.send("ホテルを含めた検索結果がありませんでした。範囲を広げます。");
                            session.sendTyping();
                            showTour(session
                                , (session.privateConversationData.city)
                                , (session.privateConversationData.spot)
                                , false);
                        }
                        else {
                            if (isSpot) {
                                // 観光地指定ありで、検索結果がなかった場合、除外して検索する
                                session.send("観光地を含めた検索結果がありませんでした。範囲を広げます。");
                                session.sendTyping();
                                showTour(session, (session.privateConversationData.city), false, false);
                            }
                            else {
                                if (isCity) {
                                    session.send("都市を含めた検索結果がありませんでした。範囲を広げます。");
                                    session.sendTyping();                                
                                    // 観光地・都市指定なしで再度検索
                                    showTour(session, false, false, false);
                                }
                                else {
                                    // 既にホテル・観光地・都市抜きで検索している場合、検索終了
                                    session.send(messages.search_zero);
                                    // プロンプトをOFF
                                    session.privateConversationData.prompt = false;                                
                                    session.endDialog();
                                }
                            }
                        }
                    }
                } else {
                    if (err) {
                        // エラー情報が入っている場合
                        throw err;                    
                    }
                    else {
                        throw new Error("ツアー情報の取得に失敗しました。 statusCode="+ response.statusCode);
                    }
                }
            });         
        },
        function (tours) {            
            // チケット情報をランダム取得
            var options = [];
            var cards = [];
            for (var tour of utils.randomArray(tours, 9)) {
                var card = {
                    "title": tour.title
                    , "image_url": tour.img[0].l
                    , "buttons": [
                        {
                            "type": "web_url",
                            "url": tour.urls.pc,
                            "title": '行ってみたい'
                        }
                        ,{
                            "type": "element_share"
                        }                        
                    ]
                }

                // var card = new builder.HeroCard(session)
                // .title(tour.title)
                // .buttons([
                //     builder.CardAction.openUrl(session, tour.urls.pc, '行ってみたい')
                // ]);
                    
                // if (tour.img.length > 0) {
                //     // キャプション画像がある場合
                //     card.text(tour.img[0].caption)
                //         .images([
                //             builder.CardImage.create(session, tour.img[0].l)
                //         ]);
                // }

                // カードに設定
                cards.push(card);
            }

            // 他の情報ボタンを追加する
            cards.push({
                "title": messages.poweredbyHearder
                , "subtitle" : messages.poweredbyAB
                , "buttons": [
                    {
                        "type": "web_url",
                        "url": messages.poweredbyABUrl,
                        "title": messages.poweredbyABTitle
                    }
                    , {
                        "type": "postback",
                        "title": messages.want_other_postback.name,
                        "payload": messages.want_other_postback.name
                    }
                ]
            });
            // 選択肢にも追加する
            session.privateConversationData.promptOptions = [{name: messages.want_other_postback.name}];
            options = [messages.want_other_postback.name];

            // まとめて流す
            // var reply = new builder.Message(session)
            //     .attachmentLayout(builder.AttachmentLayout.carousel)
            //     .attachments(cards);

            var reply = new builder.Message(session)
                .sourceEvent({
                    "facebook": {
                        "attachment": {
                            type: "template",
                            payload: {
                                template_type: "generic",
                                elements: cards
                            }
                        }
                    }
                });
                
            builder.Prompts.choice(session
                , reply
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});
        }
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}

// 翻訳
bot.dialog('/translate', [
    function(session) {
        console.log('** translate');

        if (session.message.text.length > 15) {
            session.send("15文字以内で話しかけてください");
            session.endDialog();
        }
        else {
            // 入力文字列保持
            // 空白は詰める
            session.privateConversationData.inputText = session.message.text;

            translate(session, function() {
                // 翻訳結果を保持
                saveTranslate(session);

                // 翻訳確認
                session.beginDialog('/prompt_translate');
            });
        }
    }
]);





// 翻訳処理
function translate(session, callback) {
    async.waterfall([
        // 対応言語数取得
        function (next) {
            console.log("対応言語数取得");

            // 対応言語DBの全件数をカウントする
            db.language.count({}, function(err, count){
                if (err) {
                    // エラー情報が入っている場合
                    next(err, "対応言語DBの取得に失敗しました。");
                }
                else {
                    // エラー情報がない場合、件数を次処理へ
                    next(null, count);
                }
            });
        },
        // ランダムID取得
        function (count, next) {
            console.log("ランダムID取得");
            console.log("count: "+ count);
            
            // ランダムでidを取得する
            var id = Math.floor( Math.random() * count ) + 1;
            // var id = 2;

            console.log("id: %i", id);

            // ランダムIDで翻訳対象を取得する
            db.language.find({"_id": id}, function (err, docs){
                if (err) {
                    // エラー情報が入っている場合
                    next(err, "DBの取得に失敗しました。");
                }
                else {
                    // エラー情報がない場合、ドキュメント情報の0番目をを次処理へ
                    console.log(docs[0]);
                    session.privateConversationData.languageDoc = docs[0];
                    next(null);
                }
            });
        },
        function (next) {
            // 実翻訳実行
            translateText(session
                , session.privateConversationData.languageDoc.language_code
                , session.privateConversationData.inputText
                , function(translatedText){
                    console.log("翻訳成功: %s", translatedText);
                    session.privateConversationData.translatedText = translatedText;                
                    next();
                });
        },
        function (next) {
            // 発音できる国の取得
            db.dialect.find({
                "language_code": session.privateConversationData.languageDoc.language_code
            }, function (err, docs){
                if (err) {
                    // エラー情報が入っている場合
                    next(err, "DBの取得に失敗しました。");
                }
                else {
                    if (docs.length > 0) {
                        // 発音できる国の一覧を保持
                        session.privateConversationData.dialectDocs = docs;
                    }
                    callback();
                }
            });                
        }
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}


// 実翻訳実行
function translateText(session, language_code, text, callback) {
    async.waterfall([
        // アクセストークン取得
        function (next) {
            console.log("アクセストークン取得");

            //アクセストークン設定
            var urls = {
                url: process.env.BING_ACCESSTOKEN_URI,
                headers: {
                    'Ocp-Apim-Subscription-Key': process.env.BING_TRANSLATOR_TEXT_KEY
                },
                method: 'POST'
            };
         
            //アクセストークンリクエスト送信
            request(urls, function (err, response, token) {
                if (err) {
                    console.error(err);
                    next(err, "アクセストークンの取得に失敗しました。");
                } else {
                    if (response.statusCode !== 200) {
                        console.error("error response.statusCode="+ response.statusCode);
                        next("アクセストークンの取得に失敗しました。status="+ response.statusCode);
                    } else {
                        console.log("アクセストークン取得成功");
                        next(null, 'Bearer ' + token);
                    }
                }
            });
        },
        // 翻訳処理
        function (accessToken, next) {
            console.log("翻訳処理");

            //オプションの定義
            var urls = {
                url: process.env.BING_TRANSLATOR_TEXT_API_URI,
                qs: {
                    'to': language_code,
                    'text': text
                },
                method: 'GET',
                headers: {
                    'Authorization': accessToken
                },
                json: true
            };

            console.log(urls);
            saveUrls(session, urls);

            //リクエスト送信
            request(urls, function (err, response, body) {
                if (err) {
                    console.log(err);
                    next(err, "翻訳に失敗しました。"+ messages.error_to_others);                    
                }
                else {
                    if(response.statusCode == 200) {    
                        //タグを除去して返す
                        console.log(body);
                        callback(body.replace(/<(.+?)>|<\/string>/g, ''));
                    } else {
                        // エラー情報が入っている場合
                        next(new Error("翻訳に失敗しました。"+ messages.error_to_others));
                    }
                }
            });
        }
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }        
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}


// 翻訳確認
bot.dialog('/prompt_translate', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_translate");
            var translateMsg = "「"+ session.privateConversationData.inputText
                +"」は、"+ 
                session.privateConversationData.languageDoc.language_name 
                +"で「"+ 
                session.privateConversationData.translatedText +"」と書きます。"

            // 翻訳結果を表示する（シェアボタンを付ける）
            var card = new builder.HeroCard(session)
                .title(session.privateConversationData.translatedText)
                .text(translateMsg);
            var msg = new builder.Message(session).addAttachment(card);
            session.send(msg);
        
            // 聞きたい、知りたい、選択肢
            var msg = "こんな言葉を話す国のこと、調べてみませんか？"
            var options = [];
            options.push(messages.want_know.name);
            session.privateConversationData.promptOptions = [{name: messages.want_know.name}];
            if (session.privateConversationData.dialectDocs 
                && session.privateConversationData.dialectDocs.length > 0) {
                // 発音対応している場合のみ、「聞く」表示
                options.push(messages.want_hear.name);
                session.privateConversationData.promptOptions.push({name: messages.want_know.name});
                msg += "\n\n発音を聞くこともできますよ。"
            }
            options.push(messages.not_interest)
            session.privateConversationData.promptOptions.push({name: messages.not_interest});
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();

            // 音声、公用語、
            // ボタンスタイルで表示する
            // 再度確認はしない
            builder.Prompts.choice(session
                , msg
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});    
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_translate やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 翻訳結果の選択があった場合
            console.log(results.response);

            if (results.response.entity == messages.want_hear.name) {
                // 聞きたい
                session.beginDialog('/speech');
            }
            else if (results.response.entity == messages.want_know.name) {
                // 知りたい
                session.beginDialog('/know');
            }
            else {
                // 興味なしの場合、処理終了
                session.send(messages.goodbye);
                session.endDialog();
            }
        }        
    }
]);


// 聞きたいの選択肢からの流れ
bot.dialog('/speech', [
    function(session, args, next) {        
        if (session.privateConversationData.dialectDocs.length == 1) {
            // 公用語国が1件の場合、確定
            session.privateConversationData.dialectCountry = session.privateConversationData.dialectDocs[0];
            next(null);
        }
        else {
            // 複数件ある場合、選択肢に設定
            session.privateConversationData.promptOptions = [];
            // 公用語国はとりあえず最大3件まで
            for (var doc of utils.randomArray(session.privateConversationData.dialectDocs, 3)) {
                session.privateConversationData.promptOptions.push({
                    name: doc.name
                });
            }
            session.beginDialog('/prompt_dialect_country');
        }        
    }, function(session, opt){
        for (var country of session.privateConversationData.dialectDocs) {
            if (country.name == opt.name) {
                // 公用語国情報がヒットしたら保持
                session.privateConversationData.dialectCountry = country;
                break;
            }
        }
        
        // 国関連情報を取得する
        searchDialect(session
            , session.privateConversationData.dialectCountry.name
            , null
            , function () {
                session.beginDialog('/speech_country');
            }
        );
    }
]);

// 公用語国結果が複数件ある場合
bot.dialog('/prompt_dialect_country', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_dialect_country");
            console.log(session.privateConversationData.promptOptions);
    
            // 国名を選択肢とする
            var options = [];
            for (var opt of session.privateConversationData.promptOptions) {
                options.push(opt.name);
            }
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();
            
            // ボタンスタイルで表示する
            // 再度確認はしない
            builder.Prompts.choice(session
                , messages.prompt_multi
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});            
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_dialect_country やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 公用語国の選択があった場合
            console.log(results.response);

            for (var opt of session.privateConversationData.promptOptions) {
                if (opt.name == results.response.entity) {
                    console.log("prompt_dialect_country 確定");
                    console.log(opt);
                    session.endDialogWithResult(opt);
                }
            }
        }        
    }
]);

// 公用語国確定
bot.dialog('/speech_country', [
    function(session) {
        // スピーチ
        speechText(session);
    }
]);

function searchDialect(session, dialectCountryName, cityName, callback) {
    async.waterfall([
        function (next) {
            // 国を検索対象に設定
            console.log("国情報検索 %s", dialectCountryName);
            searchCountry(session, dialectCountryName, function(results){
                if (!results) {
                    next(new Error("国情報の取得に失敗しました。"));
                }
                else {
                    if (results.length == 1) {
                        console.log("国情報1件確定");
                        console.log(results[0]);
                        session.privateConversationData.country = results[0];
                        // 首都を検索対象に設定する
                        next(null, session.privateConversationData.country.iso.capitaljp);
                    }
                    else {
                        next(new Error("国情報の取得に失敗しました。(複数件)"));
                    }
                }
            });
        },
        function (capitalName, next) {
            if (!cityName) {
                // 都市名が指定されていない場合は、首都を設定する
                cityName = capitalName;
            }
            console.log("都市情報検索 %s", cityName);
            
            searchCity(session, cityName, function(results){
                if (!results) {
                    next(new Error("都市情報の取得に失敗しました。"));
                }
                else {
                    console.log("都市情報あり");
                    console.log(results);
        
                    if (results.length == 1) {
                        console.log("都市情報1件確定");
                        console.log(results[0]);
                        session.privateConversationData.city = results[0];
                        
                        next(null);
                    }
                    else {
                        next(new Error("都市情報の取得に失敗しました。(複数件)"));
                    }
                }
            });
        }, function (next) {
            // 緯度経度確認
            searchCityLatLon(session, callback);
        }
    ], function(err, errMsg) {
        console.log(err);
        console.log(errMsg);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });        
}


// 翻訳結果を聞く
function speechText(session) {
    console.log("翻訳結果を聞く");
    var speechClient = new bingSpeechApiClient.BingSpeechClient(process.env.BING_SPEECH_API_KEY);

    // wavファイル用パス
    var wavPath = './public/wav/'
        + session.privateConversationData.inputText.replace(/\s/g, '_')
        +'-'
        + session.privateConversationData.languageDoc.language_name 
        + '-'
        + session.privateConversationData.dialectCountry.name 
        +'.wav';
    var wavWstream = fs.createWriteStream(wavPath);
    
    // mp3エンコード用パス
    var mp3FileName = 
        session.privateConversationData.inputText.replace(/\s/g, '_')
        +'-'
        + session.privateConversationData.languageDoc.language_name 
        + '-'
        + session.privateConversationData.dialectCountry.name 
        +'.mp3';
    var mp3Path = './public/mp3/'+ mp3FileName;        
    // console.log("mp3 file: %s", mp3Path);

    speechClient.synthesizeStream(
        session.privateConversationData.translatedText
        , session.privateConversationData.dialectCountry.dialect_code
        , session.privateConversationData.dialectCountry.gender).then(resultStream => {
            // streamを保存
            resultStream.pipe(wavWstream);

            // 終了したら
            resultStream.on('end', function(){
                // stream保存
                wavWstream.close();

                ffmpeg(wavPath)
                    .output(mp3Path)
                    .on("start", function(cmdline){
                        console.log("[start] %s", cmdline);
                    })
                    .on("data", function(chunk){
                        console.log("chunk");
                        console.log(chunk);
                    })
                    .on('error', function(err) {
                        console.log('An ffmpeg error occurred');
                        console.log(err);
                        var errMsg = "音声データ取得時にエラーが発生しました。もう一度話しかけて下さい。";
                        session.send(errMsg);
                        saveError(err, errMsg, session)
                        session.endDialog();
                    })
                    .on("end", function(){
                        var mp3Url = process.env.BOT_API_URI +"/mp3/"+ encodeURIComponent(mp3FileName);

                        console.log("mp3Path");
                        console.log(mp3Url);

                        // 再利用可とする
                        var reply = new builder.Message(session)
                            .sourceEvent({
                                "facebook": {
                                    "attachment": {
                                        type: "audio",
                                        payload: {
                                            "url": mp3Url
                                            , "is_reusable": true
                                        }
                                    }
                                }
                            });
                        // 音声情報だけとりあえず送る
                        session.send(reply);

                        var card = new builder.HeroCard(session)
                                            .title(session.privateConversationData.languageDoc.language_name + " ("+ session.privateConversationData.dialectCountry.name +")")
                                            .subtitle(session.privateConversationData.inputText
                                                    +" => "+ session.privateConversationData.translatedText)
                                            ;

                        // 音声情報を発信する
                        var msg = new builder.Message(session).addAttachment(card);
                        session.send(msg);

                        // メッセージを送ったら、音声ファイルは削除
                        fs.unlink(wavPath);

                        // mp3は10分後
                        setTimeout(function() {
                            console.log("mp3ファイル削除 %s", mp3Path);
                            fs.unlink(mp3Path);
                        }, 10 * 60 * 1000);

                        session.beginDialog('/prompt_know');
                    })
                    .run();
        });
    });
}

// 知りたいの選択肢からの流れ
bot.dialog('/know', [
    function(session, args, next) {        
        if (session.privateConversationData.languageDoc.countries.length == 1) {
            // 公用語国が1件の場合、確定
            next({name: session.privateConversationData.languageDoc.countries[0]});
        }
        else {
            // 複数件ある場合、選択肢に設定
            session.privateConversationData.promptOptions = [];
            // 公用語国はとりあえず最大3件まで
            for (var country of utils.randomArray(session.privateConversationData.languageDoc.countries, 3)) {
                session.privateConversationData.promptOptions.push({
                    name: country
                });
            }
            session.beginDialog('/prompt_dialect_country');
        }        
    }, function(session, dialectCountry){
        console.log("国選択確定");
        console.log(dialectCountry);
        
        // 国関連情報を取得する
        searchDialect(session
            , dialectCountry.name
            , null
            , function () {
                // どの情報を表示するか確認する
                session.beginDialog('/prompt_know');
            }
        );
    }
]);


// 知識確認
bot.dialog('/prompt_know', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_translate");
            var prompt = 
                session.privateConversationData.country.name
                +" ("
                + session.privateConversationData.city.name   
                + ")"          
                +"\n\nこんな情報はいかがですか？"
                ;
        
            // セッションに設定
            session.privateConversationData.promptOptions = messages.want_info;
            
            // 情報種別オプション
            var options = [];
            for (var opt of session.privateConversationData.promptOptions) {
                options.push(opt.name);
            }
            
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();
        
            // ボタンスタイルで表示する
            // 再度確認はしない
            builder.Prompts.choice(session
                , prompt
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});    
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_know やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 情報種別の選択があった場合
            console.log(results.response);

            for (var opt of session.privateConversationData.promptOptions) {
                if (opt.name == results.response.entity) {
                    session.beginDialog(opt.code);
                }
            }
        }        
    }
]);

// 時間
bot.dialog('/info_time', [
    function(session) {
        if (session.privateConversationData.city.lat == messages.invalid_lat) {
            session.send("緯度経度が正しく取得できていない為、時間が分かりません。");
            // 再度情報取得ダイアログ表示
            session.beginDialog("/prompt_know");
        }
        else {
            // タイムゾーンURL
            var urls = {
                url: process.env.GOOGLE_TIMEZONE_API_URI,
                qs: {
                    'key': process.env.GOOGLE_TIMEZONE_API_KEY,
                    'location': session.privateConversationData.city.lat +','+ session.privateConversationData.city.lng,
                    'timestamp': moment().unix()
                },
                method: 'GET'
            };
            
            console.log(urls);
            saveUrls(session, urls);
    
            // リクエスト送信
            request(urls, function (err, response, body) {
                if (err) {
                    console.error(err);

                    var errMsg = "時刻の取得に失敗しました。";
                    session.send(errMsg + messages.error_to_others);

                    saveError(err, errMsg, session);
                    session.endDialog();
                }
                else {
                    if(response.statusCode == 200) {
                        // タイムゾーン情報をパース
                        var timezoneJson = JSON.parse(body);
                        
                        console.log("タイムゾーン取得成功");
                        console.log(timezoneJson);
                        
                        console.log("都市の時刻取得");
            
                        // タイムゾーンに合致した時間を返す
                        var now = moment().tz(timezoneJson.timeZoneId);
                        console.log(now);
            
                        // 時刻表示
                        session.send("国: "+  session.privateConversationData.country.name
                            +"\n\n都市: "+ session.privateConversationData.city.name 
                            + "\n\n時刻: "+ now.format("YYYY年MM月DD日 A hh時mm分")
                        );

                        // 再度情報取得ダイアログ表示
                        session.beginDialog("/prompt_know");            
                    } else {
                        console.error("response.statusCode: " + response.statusCode);

                        var errMsg = "時刻の取得に失敗しました。 statusCode="+ response.statusCode;
                        session.send(errMsg + messages.error_to_others);

                        var err = new Error(errMsg);

                        saveError(err, errMsg, session);
                        session.endDialog();
                    }
                }
            });          
        }
    }
]);


// 天気
bot.dialog('/info_weather', [
    function(session) {
        if (session.privateConversationData.city.lat == messages.invalid_lat) {
            session.send("緯度経度が正しく取得できていない為、天気が分かりません。");
            // 再度情報取得ダイアログ表示
            session.beginDialog("/prompt_know");
        }
        else {
            // 天気情報APIURL
            var urls = {
                url: process.env.OPEN_WEATHER_MAP_API_URI,
                qs: {
                    'appid': process.env.OPEN_WEATHER_MAP_API_KEY,
                    'lat': session.privateConversationData.city.lat,
                    'lon': session.privateConversationData.city.lng,
                    'timestamp': moment().unix()
                },
                method: 'GET'
            };

            console.log(urls);
            saveUrls(session, urls);

            // リクエスト送信
            request(urls, function (err, response, body) {
                if (err) {
                    console.error(err);

                    var errMsg = "天気の取得に失敗しました。";
                    session.send(errMsg + messages.error_to_others);

                    saveError(err, errMsg, session);
                    session.endDialog();
                }
                else {
                    if(response.statusCode == 200) {

                        var weatherJson = JSON.parse(body);
                        
                        console.log("天気取得成功");
                        console.log(weatherJson);

                        // 天気説明を翻訳
                        translateWeather(session, weatherJson.weather[0].description, function(result){
                            console.log("天気翻訳成功");
                            console.log(result);

                            // 天気表示
                            session.send("国: "+  session.privateConversationData.country.name
                                +"\n\n都市: "+ session.privateConversationData.city.name 
                                + "\n\n天気: "+ result.translated + " ("+ result.description + ")"
                            );

                            // 再度情報取得ダイアログ表示
                            session.beginDialog("/prompt_know");
                        });
                    } else {
                        console.error("response.statusCode: " + response.statusCode);

                        var errMsg = "天気の取得に失敗しました。 statusCode="+ response.statusCode;
                        session.send(errMsg + messages.error_to_others);

                        var err = new Error(errMsg);

                        saveError(err, errMsg, session);
                        session.endDialog();
                    }
                }
            }); 
        }
    }
]);

// 天気文言を日本語に翻訳する
function translateWeather(session, description, callback) {
    async.waterfall([
        function(next) {
            // まず天気情報を検索する
            searchWeather(session, description, next);
        },
        function(result, next) {
            if (result) {
                // 既に同じ文言がある場合
                callback(result);
            }
            else {
                // まだ同じ文言がない場合
                next();
            }
        },
        function(next) {
            // 文言を日本語に翻訳する
            translateText(session, "ja", description, function(translated){
                next(null, translated);
            });
        },
        function(translated, next){
            // 天気文言を保存する
            console.log("翻訳成功: %s", translated);
            saveWeather(description, translated, next);
        },
        function(next) {
            // 再度天気情報を検索する
            searchWeather(session, description, next);
        },
        function(result, next) {
            if (result) {
                // 既に同じ文言がある場合
                // 登録したからあるはず
                callback(result);
            }
            else {
                // それでもまだ同じ文言がない場合
                // とりあえず文言そのものを返す
                callback({
                    description: description,
                    translated: description
                });
            }
        },
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}

// 天気情報の検索
function searchWeather(session, description, callback) {
    console.log("searchWeather %s", description);
    // データストアの検索
    NcmbWeatherClass
        .equalTo("description", description)
        .fetchAll()
        .then(function(results){
            // 検索結果がある場合
            console.log("Successfully retrieved " + results.length + " scores.");
            if (results.length == 0) {
                // 検索結果がない場合、nullを返す
                callback(null, null);
            }
            else {
                // 検索結果がある場合、データを返す
                callback(null, {
                    description: results[0].get("description"),
                    translated: results[0].get("translated")
                });
            }
        })
        .catch(function(err){
            // 検索に失敗した場合
            console.log(err);
        });
}

// 天気情報を保存する
function saveWeather(description, translated, callback) {
    console.log("saveText %s", description);

    var ncmbWeatherClass = new NcmbWeatherClass();
    ncmbWeatherClass
        .set("description", description)
        .set("translated", translated)
        ;

    ncmbWeatherClass.save()
        .then(function(){
            console.log("○ NcmbWeatherClass 登録成功");
            callback();
        })
        .catch(function(err){
            // 保存に失敗した場合の処理
            console.log("○ NcmbWeatherClass 登録成功");
            console.log(err);
        });    

}

// 国旗
bot.dialog('/info_flag', [
    function(session) {
        var flagUrl = process.env.BOT_API_URI +'/image/flag/' + session.privateConversationData.country.code + '@3x.png';

        console.log("flagUrl");
        console.log(flagUrl);

        var urls = {
            url: flagUrl,
            method: 'GET'
        };
        
        //リクエスト送信
        request(urls, function (err, response, body) {
            if(!err && response.statusCode == 200) {

                // ファイルがある場合はそのまま表示
                var card = new builder.HeroCard(session)
                    .title(session.privateConversationData.country.name)
                    .images([
                        builder.CardImage.create(session, flagUrl)
                    ]);
                session.send(new builder.Message(session).addAttachment(card));
                // 再度情報取得ダイアログ表示
                session.beginDialog("/prompt_know");
            } else {
                session.send("旗情報がありませんでした。");
                // 再度情報取得ダイアログ表示
                session.beginDialog("/prompt_know");
            }
        });         
    }
]);


// 地図情報を見る
bot.dialog('/prompt_info_map', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_map");
            console.log(session.privateConversationData.promptOptions);
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();

            showMap(session, session.privateConversationData.mapZoomSize);
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_map やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 地図の選択があった場合
            console.log(results.response);
            
            if (results.response.entity == messages.info_map_zoom_up_postback.name) {
                // 拡大の場合
                session.privateConversationData.mapZoomSize += 1;
                session.beginDialog('/prompt_info_map');
            }
            else if (results.response.entity == messages.info_map_zoom_down_postback.name) {
                // 縮小の場合
                session.privateConversationData.mapZoomSize -= 1;
                session.beginDialog('/prompt_info_map');
            }
            else {
                // 他の情報の場合、プロンプト表示
                session.beginDialog('/prompt_know');
            }
        }        
    }
]);


// 地図検索
function showMap(session) {
    async.waterfall([
        function(next) {
            console.log("都市情報 - 地図検索");

            // 都市の地図
            var mapUrl = process.env.BING_MAPS_STATIC_IMAGE_URI
                + encodeURIComponent(session.privateConversationData.city.lat +','+ session.privateConversationData.city.lng) 
                + "/"
                + session.privateConversationData.mapZoomSize
                +"?key="+ process.env.BING_MAPS_API_KEY 
                +"&mapSize=600,600&format=png&pushpin="
                + session.privateConversationData.city.lat 
                +','
                + session.privateConversationData.city.lng 
                + ';64;'
                + encodeURIComponent(session.privateConversationData.city.name)
                ;
            
            console.log(mapUrl);
            saveUrls(session, mapUrl);
        
            // 拡大・縮小・他の情報、選択肢
            var options = [
                messages.info_map_zoom_up_postback.name
                , messages.info_map_zoom_down_postback.name
                , messages.info_map_other_postback.name
            ];
            session.privateConversationData.promptOptions = [
                messages.info_map_zoom_up_postback
                , messages.info_map_zoom_down_postback
                , messages.info_map_other_postback
            ];
            
            // 地図データを表示する
            var card = new builder.HeroCard(session)
                .title(session.privateConversationData.country.name)
                .subtitle(session.privateConversationData.city.name)
                .images([
                    builder.CardImage.create(session, mapUrl)
                ])
                .buttons([
                    builder.CardAction.postBack(session
                        , messages.info_map_zoom_up_postback.name
                        , messages.info_map_zoom_up_postback.name)
                    , builder.CardAction.postBack(session
                        , messages.info_map_zoom_down_postback.name
                        , messages.info_map_zoom_down_postback.name)
                    , builder.CardAction.postBack(session
                        , messages.info_map_other_postback.name
                        , messages.info_map_other_postback.name)
                ]);
                
            builder.Prompts.choice(session
                , new builder.Message(session).addAttachment(card)
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});
        }
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}




// 観光地情報を見る
bot.dialog('/prompt_info_spot', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_spot");
            console.log(session.privateConversationData.promptOptions);
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();

            showSpot(session, true);
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_spot やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 観光地の選択があった場合
            console.log(results.response);
            
            if (results.response.entity == messages.want_other_postback.name) {
                session.beginDialog('/prompt_know');                
            }
            else {
                for (var opt of session.privateConversationData.promptOptions) {
                    if (opt.name == results.response.entity) {
                        console.log("prompt_spot 確定");
                        console.log(opt);

                        // 選択された観光地を保持
                        session.privateConversationData.spot = opt;

                        // エンティティを保持
                        session.privateConversationData.luisEntity = new LuisEntity();
                
                        // ツアー情報表示
                        session.beginDialog('/tour');
                    }
                }
            }
        }        
    }, function(session) {
        // ツアー表示が終わったら、次の情報を促す
        session.beginDialog('/prompt_know');
    }
]);


// 観光地検索
function showSpot(session, isCity) {
    async.waterfall([
        function(next) {
            console.log("都市情報 - 観光地検索");

            var searchMsg = "【検索条件】";

            var qsOptions = {
                'key': process.env.AB_ROAD_API_KEY,
                'count': 50,
                'format': 'json'
            }

            // 国指定あり
            if (session.privateConversationData.country) {
                qsOptions['country'] = session.privateConversationData.country.code;
                searchMsg += "\n\n国: "+ session.privateConversationData.country.name;
            }

            // 都市指定あり
            if (isCity && session.privateConversationData.city) {
                qsOptions['city'] = session.privateConversationData.city.code;
                searchMsg += "\n\n都市: "+ session.privateConversationData.city.name;
            }

            var urls = {
                url: process.env.AB_ROAD_SPOT_URI,
                qs: qsOptions,
                method: 'GET'
            };
            
            console.log(urls);
            saveUrls(session, urls);
            
            // 検索条件を流す
            session.send(searchMsg);
            session.sendTyping();
            
            //リクエスト送信
            request(urls, function (err, response, body) {
                if(!err && response.statusCode == 200) {
        
                    var json = JSON.parse(body);
        
                    console.log("AB観光地情報");
                    // console.log(json);
        
                    if (json.results.spot.length > 0) {
                        // 検索結果がある場合、次へ
                        next(null, json.results.spot);
                    }
                    else {
                        if (isCity) {
                            session.send("都市を含めた検索結果がありませんでした。範囲を広げます。");
                            session.sendTyping();
                            // 都市指定なしで再度検索
                            showSpot(session, false);
                        }
                        else {
                            // 既に都市抜きで検索している場合、検索終了
                            session.send(messages.search_zero);
                            // プロンプトをOFF
                            session.privateConversationData.prompt = false;
                            session.endDialog();
                        }
                    }
                } else {
                    if (err) {
                        // エラー情報が入っている場合
                        throw err;                    
                    }
                    else {
                        throw new Error("観光地情報の取得に失敗しました。 statusCode="+ response.statusCode);
                    }
                }
            });         
        },
        function (spots) {            
            // 観光地情報をランダム取得
            session.privateConversationData.promptOptions = [];
            var options = [];
            var cards = [];
            for (var spot of utils.randomArray(spots, 9)) {
                var card = new builder.HeroCard(session)
                .title(spot.name)
                .subtitle(spot.title)
                .text(spot.description)
                .buttons([
                    builder.CardAction.openUrl(session, spot.url, '詳しく見る')
                    , builder.CardAction.postBack(session, 
                        spot.name, messages.want_spot_postback.name)
                ]);

                // カードに設定
                cards.push(card);

                // 選択肢に追加
                session.privateConversationData.promptOptions.push(spot);     
                options.push(spot.name);           
            }

            // 最後に、他の情報を見る、のカードと選択肢を追加する
            cards.push(
                new builder.HeroCard(session)
                    .title(messages.poweredbyHearder)
                    .text(messages.poweredbyAB)
                    .buttons([
                        builder.CardAction.postBack(session
                            , messages.want_other_postback.name
                            , messages.want_other_postback.name)
                    ])
            );
            session.privateConversationData.promptOptions.push({name: messages.want_other_postback.name});
            options.push(messages.want_other_postback.name);

            // まとめて流す
            var reply = new builder.Message(session)
                .attachmentLayout(builder.AttachmentLayout.carousel)
                .attachments(cards);
            builder.Prompts.choice(session
                , reply
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});
        }
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}

// ホテル情報を見る
bot.dialog('/prompt_info_hotel', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_hotel");
            console.log(session.privateConversationData.promptOptions);
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();

            showHotel(session, true);
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_hotel やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // ホテルの選択があった場合
            console.log(results.response);
            
            if (results.response.entity == messages.want_other_postback.name) {
                session.beginDialog('/prompt_know');                
            }
            else {
                for (var opt of session.privateConversationData.promptOptions) {
                    if (opt.name == results.response.entity) {
                        console.log("prompt_hotel 確定");
                        console.log(opt);

                        // 選択されたホテルを保持
                        session.privateConversationData.hotel = opt;

                        // エンティティを保持
                        session.privateConversationData.luisEntity = new LuisEntity();
                
                        // ツアー情報表示
                        session.beginDialog('/tour');
                    }
                }
            }
        }        
    }, function(session) {
        // ツアー表示が終わったら、次の情報を促す
        session.beginDialog('/prompt_know');
    }
]);


// ホテル検索
function showHotel(session, isCity) {
    async.waterfall([
        function(next) {
            console.log("都市情報 - ホテル検索");

            var searchMsg = "【検索条件】";

            var qsOptions = {
                'key': process.env.AB_ROAD_API_KEY,
                'count': 50,
                'format': 'json'
            }

            // 国指定あり
            if (session.privateConversationData.country) {
                qsOptions['country'] = session.privateConversationData.country.code;
                searchMsg += "\n\n国: "+ session.privateConversationData.country.name;
            }

            // 都市指定あり
            if (isCity && session.privateConversationData.city) {
                qsOptions['city'] = session.privateConversationData.city.code;
                searchMsg += "\n\n都市: "+ session.privateConversationData.city.name;
            }

            var urls = {
                url: process.env.AB_ROAD_HOTEL_URI,
                qs: qsOptions,
                method: 'GET'
            };
            
            console.log(urls);
            saveUrls(session, urls);
            
            // 検索条件を流す
            session.send(searchMsg);
            session.sendTyping();
            
            //リクエスト送信
            request(urls, function (err, response, body) {
                if(!err && response.statusCode == 200) {
        
                    var json = JSON.parse(body);
        
                    console.log("ABホテル情報");
                    // console.log(json);
        
                    if (json.results.hotel && json.results.hotel.length > 0) {
                        // 検索結果がある場合、次へ
                        next(null, json.results.hotel);
                    }
                    else {
                        if (isCity) {
                            session.send("都市を含めた検索結果がありませんでした。範囲を広げます。");
                            session.sendTyping();
                            // 都市指定なしで再度検索
                            showHotel(session, false);
                        }
                        else {
                            // 既に都市抜きで検索している場合、検索終了
                            session.send(messages.search_zero);
                            // プロンプトをOFF
                            session.privateConversationData.prompt = false;
                            session.endDialog();
                        }
                    }
                } else {
                    if (err) {
                        // エラー情報が入っている場合
                        throw err;                    
                    }
                    else {
                        throw new Error("ホテル情報の取得に失敗しました。 statusCode="+ response.statusCode);
                    }
                }
            });         
        },
        function (hotels) {            
            // ホテル情報をランダム取得
            session.privateConversationData.promptOptions = [];
            var options = [];
            var cards = [];
            for (var hotel of utils.randomArray(hotels, 9)) {
                var card = new builder.HeroCard(session)
                .title(hotel.name)
                .buttons([
                    builder.CardAction.postBack(session, 
                        hotel.name, messages.want_hotel_postback.name)
                ]);

                // カードに設定
                cards.push(card);

                // 選択肢に追加
                session.privateConversationData.promptOptions.push(hotel);     
                options.push(hotel.name);           
            }

            // 最後に、他の情報を見る、のカードと選択肢を追加する
            cards.push(
                new builder.HeroCard(session)
                    .title(messages.poweredbyHearder)
                    .text(messages.poweredbyAB)            
                    .buttons([
                        builder.CardAction.postBack(session
                            , messages.want_other_postback.name
                            , messages.want_other_postback.name)
                    ])
            );
            session.privateConversationData.promptOptions.push({name: messages.want_other_postback.name});
            options.push(messages.want_other_postback.name);

            // まとめて流す
            var reply = new builder.Message(session)
                .attachmentLayout(builder.AttachmentLayout.carousel)
                .attachments(cards);
            builder.Prompts.choice(session
                , reply
                , options
                , {listStyle: builder.ListStyle.button, maxRetries: 0});
        }
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}

// ツアー情報を見る
bot.dialog('/prompt_info_tour', [
    function (session, args, next) {
        // エンティティを保持
        session.privateConversationData.luisEntity = new LuisEntity();
        
        // ツアー情報表示
        session.beginDialog('/tour');
    }, function(session) {
        // ツアー表示が終わったら、次の情報を促す
        session.beginDialog('/prompt_know');
    }
]);


// 他の都市情報を見る
bot.dialog('/prompt_info_other_city', [
    function (session, args, next) {
        console.log(session.dialogStack());
                        
        if (session.privateConversationData.prompt) {
            // 結果に詰め直す
            var results = {
                "response": {"entity": session.message.text},
                "args": args
            };
            // プロンプト再開の場合、スキップ
            next(results);
        }
        else {
            console.log("** prompt_other_city");
            console.log(session.privateConversationData.promptOptions);
    
            console.log("session.dialogStack()");
            console.log(session.dialogStack());
    
            // プロンプト有効
            session.privateConversationData.prompt = true;
            // スタック設定
            session.privateConversationData.dialogStack = session.dialogStack();

            showOtherCity(session, true);
        }        
    },
    function (session, results) {
        // プロンプト終了
        session.privateConversationData.prompt = false;

        console.log("results");
        console.log(results);

        if (!results.response) {
            console.log("prompt_other_city やり直し");
            // セッションをリセットする
            session.reset();
        }
        else {
            // 他の都市の選択があった場合
            console.log(results.response);
            
            if (results.response.entity == messages.want_other_postback.name) {
                session.beginDialog('/prompt_know');                
            }
            else {
                for (var opt of session.privateConversationData.promptOptions) {
                    if (opt.name == results.response.entity) {
                        console.log("prompt_other_city 確定");
                        console.log(opt);

                        // 選択された他の都市を保持
                        session.privateConversationData.city = opt;

                        // 緯度経度確認
                        searchCityLatLon(session, function(){
                            session.beginDialog('/prompt_know');
                        });
                    }
                }
            }
        }        
    }
]);

// 他の都市検索
function showOtherCity(session, isCity) {
    async.waterfall([
        function(next) {
            console.log("都市情報 - 他の都市検索");
                
            // 選択された都市名を含まない都市情報を取得する
            try {
                searchCity(session, null, function(results){
                    if (!results) {
                        console.log("都市情報なし");
                        session.endDialogWithResult(null);
                    }
                    else {
                        console.log("都市情報あり");
                        console.log(results);

                        if (results.length == 1) {
                            console.log("都市情報1件");
                            console.log(results[0]);

                            if (results[0].code == session.privateConversationData.city.code) {
                                // 都市コードが同じ場合
                                // 都市情報nullで次に渡す
                                next(null, null);
                            }
                            else {
                                next(null, results);
                            }
                        }
                        else {
                            // 今指定している都市を除いて次に渡す
                            next(null, results.filter(function(v){
                                return v.code != session.privateConversationData.city.code;
                            }));
                        }
                    }
                });
            } catch (error) {
                console.log(error);
                session.send(error.message + "\n\n"+ messages.error_to_others);
                saveError(error, null, session);
                session.endDialog();
            }
        },
        function (other_cities) {         
            if (other_cities) {
                // 他の都市情報をランダム取得
                session.privateConversationData.promptOptions = [];
                var options = [];
                var cards = [];
                for (var other_city of utils.randomArray(other_cities, 9)) {
                    var card = new builder.HeroCard(session)
                    .title(other_city.name)
                    .buttons([
                        builder.CardAction.postBack(session, 
                            other_city.name, messages.want_other_city_postback.name)
                    ]);

                    // カードに設定
                    cards.push(card);

                    // 選択肢に追加
                    session.privateConversationData.promptOptions.push(other_city);     
                    options.push(other_city.name);           
                }

                // 最後に、他の情報を見る、のカードと選択肢を追加する
                cards.push(
                    new builder.HeroCard(session)
                        .title(messages.poweredbyHearder)
                        .text(messages.poweredbyAB)
                        .buttons([
                            builder.CardAction.postBack(session
                                , messages.want_other_postback.name
                                , messages.want_other_postback.name)
                        ])
                );
                session.privateConversationData.promptOptions.push({name: messages.want_other_postback.name});
                options.push(messages.want_other_postback.name);

                // まとめて流す
                var reply = new builder.Message(session)
                    .attachmentLayout(builder.AttachmentLayout.carousel)
                    .attachments(cards);
                builder.Prompts.choice(session
                    , reply
                    , options
                    , {listStyle: builder.ListStyle.button, maxRetries: 0});
            }
            else {
                session.send("他の都市が見つかりませんでした。");
                session.endDialog();
            }
        }
    ], function(err, errMsg) {
        console.log(errMsg);
        console.log(err);
        if (!errMsg && err) {
            // エラーがあって、メッセージがない場合、上書き
            errMsg = err.message;
        }
        session.send(errMsg);
        saveError(err, errMsg, session);
        session.endDialog();
    });
}

// 他の人の翻訳情報
bot.dialog('/other_translate', [
    function (session, args) {
        console.log('** other_translate');

        searchOtherTranslate(session, function(result){
            if (result) {
                // 結果があった場合、翻訳情報の詰め直しを行う
                // 一度初期化
                initialize(session);

                session.privateConversationData.inputText = result.get("inputText");
                session.privateConversationData.translatedText = result.get("translatedText");
                session.privateConversationData.languageDoc = result.get("languageDoc");
                session.privateConversationData.dialectDocs = result.get("dialectDocs");
                session.privateConversationData.dialectCountry = result.get("dialectCountry");       
                
                // 翻訳結果確認ダイアログ開始
                session.beginDialog("/prompt_translate");
            }
            else {
                session.send("他の人の翻訳情報が見つけられませんでした。"+ messages.error_to_others);
            }
        });
    }
]).triggerAction({
    matches: 'OtherTranslate'
});

function searchOtherTranslate(session, callback) {
    console.log("searchOtherTranslate");
    // データストアの検索
    NcmbTranslateClass
        // 最大20件まで
        .limit(20)
        // 作成日の降順
        .order("createDate", true)
        // 自身のユーザIDを除く
        .notEqualTo("user_id", session.message.user.id)
        // データを取得する
        .fetchAll()
        .then(function(results){
            if (results.length > 0) {
                // 検索結果がある場合
                console.log("Successfully retrieved " + results.length + " scores.");
                // ランダムidxを生成する
                var idx = Math.floor(Math.random() * results.length);
                console.log("idx = "+ idx);
                // ランダムIDXの取得結果を返す
                callback(results[idx]);
            }
            else {
                console.log("検索結果なし");
                // 検索結果がない場合
                callback(null);
            }
        })
        .catch(function(err){
            // 検索に失敗した場合
            console.log(err);
        });
}













function saveError(err, errMsg, session) {
    // データストアへの登録
    var ncmbErrorClass = new NcmbErrorClass();

    try {
        if (session) {
            // セッションがある場合
            ncmbErrorClass
                .set('user_id', session.message.user.id)
                .set('user_name', session.message.user.name)
                .set('message', session.message.text)
                .set('error', err)
                .set('stacktrace', err.stack)
                .set('errMsg', errMsg)
                .set('timestamp', ''+ session.localTimestamp)
                .set('sender_id', (session.message.sourceEvent && session.message.sourceEvent.sender) ? session.message.sourceEvent.sender.id : '')
                .set('page_id', (session.message.sourceEvent && session.message.sourceEvent.recipient) ? session.message.sourceEvent.recipient.id : '')
                ;
        }
        else {
            // セッションがない場合、エラーだけ
            ncmbErrorClass
                .set('error', err)
                .set('stacktrace', err.stack)
                .set('errMsg', errMsg)
                ;
        }

        ncmbErrorClass.save().then(function(){
            console.log("○ NcmbErrorClass 登録成功");
        }).catch(function(err){
            console.log("× NcmbErrorClass 登録失敗");
        });
    } catch (error) {
        console.log(error);            
    }
    
}

function saveUrls(session, urls) {

    // データストアへの登録
    var ncmbUrlsClass = new NcmbUrlsClass();
    try {
        ncmbUrlsClass
            .set('user_id', session.message.user.id)
            .set('user_name', session.message.user.name)
            .set('message', session.message.text)
            .set('urls', urls)
            .set('timestamp', ''+ session.localTimestamp)
            .set('sender_id', (session.message.sourceEvent && session.message.sourceEvent.sender) ? session.message.sourceEvent.sender.id : '')
            .set('page_id', (session.message.sourceEvent && session.message.sourceEvent.recipient) ? session.message.sourceEvent.recipient.id : '')
            ;
        ncmbUrlsClass.save().then(function(){
            console.log("○ NcmbUrlsClass 登録成功");
        }).catch(function(err){
            console.log("× NcmbUrlsClass 登録失敗");
        });
    } catch (error) {
        console.log(error);            
    }
    
}

function saveTour(session, tourOptions) {
    // データストアへの登録
    var ncmbTourClass = new NcmbTourClass();
    try {
        ncmbTourClass
            .set('user_id', session.message.user.id)
            .set('user_name', session.message.user.name)
            .set('message', session.message.text)
            .set('options', tourOptions)
            .set('timestamp', ''+ session.localTimestamp)
            .set('sender_id', (session.message.sourceEvent && session.message.sourceEvent.sender) ? session.message.sourceEvent.sender.id : '')
            .set('page_id', (session.message.sourceEvent && session.message.sourceEvent.recipient) ? session.message.sourceEvent.recipient.id : '')
            ;
        ncmbTourClass.save().then(function(){
            console.log("○ NcmbTourClass 登録成功");
        }).catch(function(err){
            console.log("× NcmbTourClass 登録失敗");
        });
    } catch (error) {
        console.log(error);            
    }
}

function saveTranslate(session, tourOptions) {
    // データストアへの登録
    var ncmbTranslateClass = new NcmbTranslateClass();
    try {
        ncmbTranslateClass
            .set('user_id', session.message.user.id)
            .set('user_name', session.message.user.name)
            .set('inputText', session.privateConversationData.inputText)
            .set('translatedText', session.privateConversationData.translatedText)
            .set('languageDoc', session.privateConversationData.languageDoc)
            .set('dialectDocs', session.privateConversationData.dialectDocs)
            .set('dialectCountry', session.privateConversationData.dialectCountry)
            .set('timestamp', ''+ session.localTimestamp)
            .set('sender_id', (session.message.sourceEvent && session.message.sourceEvent.sender) ? session.message.sourceEvent.sender.id : '')
            .set('page_id', (session.message.sourceEvent && session.message.sourceEvent.recipient) ? session.message.sourceEvent.recipient.id : '')
            ;
        ncmbTranslateClass.save().then(function(){
            console.log("○ NcmbTranslateClass 登録成功");
        }).catch(function(err){
            console.log("× NcmbTranslateClass 登録失敗");
        });
    } catch (error) {
        console.log(error);            
    }
}

