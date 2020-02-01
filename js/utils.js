
// 重複なくランダムに複数の要素を取り出す
exports.randomArray = function (array, num) {
    var a = array;
    var t = [];
    var r = [];
    var l = a.length;
    var n = num < l ? num : l;
    while (n-- > 0) {
        var i = Math.random() * l | 0;
        r[n] = t[i] || a[i];
        --l;
        t[i] = t[l] || a[l];
    }
    return r;
}

// asyncのループ
exports.asyncLoop = function (iterations, func, callback) {
    var index = 0;
    var done = false;
    var loop = {
        next: function() {
            if (done) {
                return;
            }

            if (index < iterations) {
                index++;
                func(loop);

            } else {
                done = true;
                callback();
            }
        },

        iteration: function() {
            return index - 1;
        },

        break: function() {
            done = true;
            callback();
        }
    };
    loop.next();
    return loop;
}

// 型判定
exports.isType = function (type, obj) {
    var clas = Object.prototype.toString.call(obj).slice(8, -1);
    return obj !== undefined && obj !== null && clas === type;
}


exports.isLuisCondition = function(luisEntity){
    if (!luisEntity) {
        return false;
    }

    // 条件系のエンティティが入っているか
    if (luisEntity.isDayToday || luisEntity.isDayTomorrow || luisEntity.isMonthRelativeThis
        || luisEntity.isMonthRelativeNext || luisEntity.isMonthRelativeAfterNext || luisEntity.isYearRelativeThis 
        || luisEntity.isYearRelativeNext) {
        return true;
    }

    // 文字列系のエンティティが入っているか
    // pref(県)は、結果としてdeptが入っているかでチェックするので、ここではチェック対象外
    if ((luisEntity.year && luisEntity.year.length > 0)
        || (luisEntity.month && luisEntity.month.length > 0)
        || (luisEntity.yyyymm && luisEntity.yyyymm.length > 0)
    ) {
        return true;
    }

    // オブジェクト系のエンティティが入っているか
    if (luisEntity.dept) {
        return true;
    }

    // 配列系のエンティティが入っているか
    if (luisEntity.keyword && luisEntity.keyword.length > 0) {
        return true;
    }

    return false;
}
